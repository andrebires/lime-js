import Command, { CommandMethod, CommandStatus } from "./Command";
import MessageAssembler, { AssemblyLimits } from "./MessageAssembler";
import { ContentTypeRegistry } from "../ContentTypes";
import { has } from "./Validation";

export type CommandDirection = "incoming" | "outgoing";
export interface CommandAssemblyResult { command?: Command; response: boolean; }
interface Exchange { local: boolean; method: string; submitted: boolean; request?: Command; response?: Command; }
const methods = Object.values(CommandMethod);
export function validateCommand(command: Command): void {
  if (!methods.includes(command.method)) throw new Error("Invalid command method");
  if ((typeof command.id !== "string" || !command.id) && !(command.id === undefined && command.method === "observe" && command.stream === undefined)) throw new Error("Command requires an id");
  const allowed = ["id", "from", "to", "pp", "metadata", "method", "uri", "type", "resource", "stream", "status", "reason"];
  for (const key of Object.keys(command)) if (!allowed.includes(key)) throw new Error("Field not permitted on command");
  if (command.uri !== undefined && (typeof command.uri !== "string" || !command.uri)) throw new Error("Invalid command URI");
  if (command.status !== undefined && !Object.values(CommandStatus).includes(command.status)) throw new Error("Invalid command status");
  if (command.status === "failure") {
    if (!command.reason || !Number.isInteger(command.reason.code) || (command.reason.description !== undefined && typeof command.reason.description !== "string")) throw new Error("Command failure requires reason");
  } else if (has(command, "reason")) throw new Error("Reason requires failure status");
  switch (command.stream) {
    case undefined:
      if (has(command, "uri") === has(command, "status")) throw new Error("Complete command requires URI or status exclusively");
      if (has(command, "resource") !== has(command, "type")) throw new Error("Command resource and type required together");
      break;
    case "start":
      if (typeof command.type !== "string" || !command.type || has(command, "resource") || has(command, "status")) throw new Error("Command start requires type and no resource/status");
      break;
    case "data":
      if (!has(command, "resource") || has(command, "type") || has(command, "uri") || has(command, "status")) throw new Error("Command data requires resource and no type/URI/status");
      break;
    case "end":
      if (has(command, "resource") || has(command, "type") || has(command, "uri")) throw new Error("Command end forbids resource/type/URI");
      break;
    default: throw new Error("Unknown command stream signal");
  }
}

// One endpoint/session owns both directions. URI identifies a request start;
// data/end inherit the role from this exchange, never from missing status.
export default class CommandAssembler {
  private exchanges = new Map<string, Exchange>();
  private parts: MessageAssembler;
  constructor(private registry = new ContentTypeRegistry(), limits: AssemblyLimits = {}, private maxCommands = 256) {
    if (!Number.isSafeInteger(maxCommands) || maxCommands < 0) throw new Error("Command capacity must be a nonnegative safe integer");
    this.parts = new MessageAssembler(registry, limits);
  }
  get size(): number { return this.exchanges.size; }
  private key(command: Command, direction: CommandDirection): string {
    return JSON.stringify([direction === "incoming" ? command.from || "" : command.to?.toString() || "", command.id]);
  }
  has(command: Command, direction: CommandDirection): boolean { return this.exchanges.has(this.key(command, direction)); }
  discard(command: Command, direction: CommandDirection): void {
    const key = this.key(command, direction);
    this.exchanges.delete(key);
    this.parts.discard({ id: key + "/request" }); this.parts.discard({ id: key + "/response" });
  }
  reset(): void { this.exchanges.clear(); this.parts.reset(); }
  accept(command: Command, direction: CommandDirection): CommandAssemblyResult {
    if (direction !== "incoming" && direction !== "outgoing") throw new Error("Invalid command direction");
    const key = this.key(command, direction);
    try { return this.apply(command, direction, key); }
    catch (error) { this.discard(command, direction); throw error; }
  }
  private apply(command: Command, direction: CommandDirection, key: string): CommandAssemblyResult {
    validateCommand(command);
    let exchange = this.exchanges.get(key);
    const initial = command.stream === undefined || command.stream === "start";
    const request = initial && has(command, "uri");
    if (request) {
      if (exchange) throw new Error("Command id is already active in this peer context");
      if (!command.id) return { command: this.complete(command), response: false };
      if (this.exchanges.size >= this.maxCommands) throw new Error("Command exchange capacity exceeded");
      exchange = { local: direction === "outgoing", method: command.method, submitted: false };
      this.exchanges.set(key, exchange);
    }
    // Ordinary unsolicited responses remain observable. A streamed response
    // always needs a correlated request, including a matching method and peer.
    if (!exchange) {
      if (command.stream === undefined && command.status) return { command: this.complete(command), response: true };
      throw new Error("Command stream has no matching request");
    }
    if (exchange.method !== command.method) throw new Error("Command method mismatch");
    const response = exchange.local !== (direction === "outgoing");
    if (initial && !request && !response) throw new Error("Command direction conflicts with active request");
    if (response && !exchange.submitted && command.status !== "failure") throw new Error("Command request has not ended");
    const role = response ? "response" : "request";
    const partID = key + "/" + role;
    if (command.stream === undefined) {
      if (exchange[role]) throw new Error("Complete command conflicts with active stream");
      const complete = this.complete(command);
      if (response) this.discard(command, direction);
      else exchange.submitted = true;
      return { command: complete, response };
    }
    if (command.stream === "start") {
      if (exchange[role]) throw new Error("Command stream already started");
      this.parts.accept({ id: partID, type: command.type, stream: "start" });
      exchange[role] = { ...command, type: this.registry.resolve(command.type) };
      return { response };
    }
    const start = exchange[role];
    if (!start) throw new Error("Command stream has not started");
    if ((command.from !== undefined && command.from !== start.from) ||
        (command.to !== undefined && command.to.toString() !== start.to?.toString()) || command.pp !== start.pp) throw new Error("Command stream routing changed");
    if (command.stream === "data") {
      this.parts.accept({ id: partID, stream: "data", content: command.resource });
      return { response };
    }
    if (response !== has(command, "status")) throw new Error("Only response end requires status");
    if (response && command.status === "failure") {
      this.discard(command, direction);
      const { type, stream, ...header } = start;
      return { command: { ...header, status: command.status, reason: { ...command.reason } }, response };
    }
    const resource = this.parts.accept({ id: partID, stream: "end" }).content;
    const { stream, ...header } = start;
    const complete: Command = { ...header, resource };
    if (response) { complete.status = command.status; this.discard(command, direction); }
    else { exchange.submitted = true; exchange.request = undefined; }
    return { command: complete, response };
  }
  private complete(command: Command): Command {
    if (!has(command, "resource")) return { ...command };
    const resource = this.parts.accept({ type: command.type, content: command.resource });
    return { ...command, type: resource.type, resource: resource.content };
  }
}
