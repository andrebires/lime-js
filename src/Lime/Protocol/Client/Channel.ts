import Envelope from "../Envelope";
import Message, { MessageListener } from "../Message";
import Command, { CommandListener, CommandMethod, CommandStatus } from "../Command";
import Notification, { NotificationListener, NotificationEvent } from "../Notification";
import Session, { SessionListener, SessionState } from "../Session";
import Transport from "../Network/Transport";
import { ContentTypeRegistry } from "../../ContentTypes";
import MessageAssembler, { AssemblyLimits } from "../MessageAssembler";
import CommandAssembler from "../CommandAssembler";
import DeliveryBuffer, { PendingDelivery } from "./DeliveryBuffer";
import { validateNotification, validateMessage } from "../Validation";

export interface MessageChannel extends MessageListener { sendMessage(message: Message): void; }
export interface CommandChannel extends CommandListener { sendCommand(command: Command): void; }
export interface NotificationChannel extends NotificationListener { sendNotification(notification: Notification): void; }
export interface SessionChannel extends SessionListener { sendSession(session: Session): void; }
export interface CommandProcessor extends CommandListener { processCommand(command: Command, timeout?: number): Promise<Command>; }
export interface ChannelOptions extends AssemblyLimits {
  version?: 1 | 2;
  sessionTimeout?: number;
  maxPendingMessages?: number;
  maxPendingCommands?: number;
  commandStreamTimeout?: number;
  retryInterval?: number;
  maxRetryAttempts?: number;
}
interface PendingCommand { resolve: (command: Command) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; recipient: string; method: string; }

export default abstract class Channel implements MessageChannel, CommandChannel, NotificationChannel, SessionChannel, CommandProcessor {
  commandTimeout = 6000;
  transport: Transport;
  remoteNode: string;
  localNode: string;
  sessionId: string;
  state: SessionState = SessionState.NEW;
  readonly version: 1 | 2;
  readonly contentTypes = new ContentTypeRegistry();
  private incoming: MessageAssembler;
  private outgoing: MessageAssembler;
  private deliveries: DeliveryBuffer;
  private commands = new Map<string, PendingCommand>();
  private commandAssembly: CommandAssembler;
  private commandTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly commandStreamTimeout: number;
  private retryTimer: ReturnType<typeof setTimeout>;
  private finalReceiptTimers = new Map<PendingDelivery, ReturnType<typeof setTimeout>>();
  private readonly maxPendingCommands: number;
  private readonly retryInterval: number;
  private readonly maxRetryAttempts: number;
  private disposed = false;

  constructor(transport: Transport, private autoReplyPings = true, private autoNotifyReceipt?: boolean, options: ChannelOptions = {}) {
    this.transport = transport;
    this.version = options.version ?? 2;
    if (this.version !== 1 && this.version !== 2) throw new Error("Unsupported protocol version");
    this.autoNotifyReceipt = autoNotifyReceipt ?? (this.version === 2);
    this.incoming = new MessageAssembler(this.contentTypes, options);
    this.outgoing = new MessageAssembler(this.contentTypes, options);
    this.deliveries = new DeliveryBuffer(options.maxPendingMessages ?? 256);
    this.maxPendingCommands = options.maxPendingCommands ?? 256;
    this.commandAssembly = new CommandAssembler(this.contentTypes, options, this.maxPendingCommands);
    this.commandStreamTimeout = options.commandStreamTimeout ?? 30000;
    if (!Number.isSafeInteger(this.commandStreamTimeout) || this.commandStreamTimeout < 1 || this.commandStreamTimeout > 2147483647) throw new Error("Invalid command stream timeout");
    this.retryInterval = options.retryInterval ?? 5000;
    this.maxRetryAttempts = options.maxRetryAttempts ?? 3;
    for (const value of [this.maxPendingCommands, this.retryInterval, this.maxRetryAttempts]) {
      if (!Number.isSafeInteger(value) || value < 0) throw new Error("Client limits must be nonnegative safe integers");
    }
    if (this.retryInterval > 2147483647) throw new Error("Retry interval exceeds timer range");
    this.transport.onEnvelope = envelope => this.receive(envelope);
  }
  abstract onMessage(message: Message): void;
  abstract onCommand(command: Command): void;
  abstract onNotification(notification: Notification): void;
  abstract onSession(session: Session): void;
  onMessageProgress(message: Message): void {}
  onCommandProgress(command: Command, response: boolean): void {}
  onCommandError(error: Error, command: Command): void {}
  onProtocolError(error: Error, envelope: Envelope): void { throw error; }
  onDeliveryError(error: Error, message: Message): void {}

  private receive(envelope: Envelope): void {
    if (this.disposed) return;
    const isMessage = Envelope.isMessage(envelope);
    if (this.version === 1 && isMessage) {
      const message = envelope as Message;
      if (message.stream !== undefined) { this.onProtocolError(new Error("LIME 1 does not support streaming"), envelope); return; }
      this.onMessage(message);
      this.notifyMessage(message);
      return;
    }
    const isNotification = Envelope.isNotification(envelope);
    const isCommand = Envelope.isCommand(envelope);
    const isSession = Envelope.isSession(envelope);
    if (Number(isMessage) + Number(isNotification) + Number(isCommand) + Number(isSession) !== 1) {
      const error = new Error("Envelope must identify exactly one family");
      if (isCommand && this.version === 2 && this.isForMe(envelope)) this.dropCommand(envelope as Command, "incoming", error);
      this.onProtocolError(error, envelope);
      return;
    }
    if (isMessage) {
      const message = envelope as Message;
      let complete: Message;
      try {
        this.requireEstablished();
        complete = this.incoming.accept(this.normalized(message));
      } catch (error) {
        // Invalid data must never leave a stream that can later be acknowledged.
        try { this.incoming.discard(this.normalized(message)); } catch { /* Invalid identity has no assembly. */ }
        this.onProtocolError(error as Error, envelope);
        return;
      }
      if (message.stream !== undefined) this.onMessageProgress(message);
      if (complete) {
        this.onMessage(complete);
        this.notifyMessage(complete);
      }
    } else if (isNotification) {
      const notification = envelope as Notification;
      try {
        if (this.version === 2) {
          this.requireEstablished();
          validateNotification(notification);
          if (!this.isForMe(notification)) throw new Error("Receipt is addressed to another node");
          this.deliveries.acknowledge(notification, notification.from || this.remoteNode || "");
          this.scheduleRetries();
        }
      } catch (error) { this.onProtocolError(error as Error, envelope); return; }
      this.onNotification(notification);
    } else if (isCommand) {
      let command = envelope as Command;
      if (this.version === 2 && this.isForMe(command)) {
        try {
          this.requireEstablished();
          const result = this.commandAssembly.accept(this.normalizedCommand(command), "incoming");
          this.syncCommandTimer(command, "incoming");
          if (command.stream === "start" || command.stream === "data") this.onCommandProgress(command, result.response);
          if (!result.command) return;
          command = result.command;
        } catch (error) {
          this.dropCommand(command, "incoming", error as Error);
          this.onProtocolError(error as Error, envelope); return;
        }
      } else if (command.stream !== undefined) {
        this.onProtocolError(new Error("Unsupported or misaddressed command stream"), envelope); return;
      }
      const pending = command.status && this.commands.get(command.id);
      if (pending && command.method === pending.method && this.isForMe(command) && (command.from || this.remoteNode || "") === pending.recipient) {
        clearTimeout(pending.timer);
        this.commands.delete(command.id);
        pending.resolve(command);
        return;
      }
      if (this.autoReplyPings && !command.status && command.id && command.uri === "/ping" && command.method === CommandMethod.GET && this.isForMe(command)) {
        this.sendCommand({ id: command.id, to: command.from, method: CommandMethod.GET, status: CommandStatus.SUCCESS,
          type: "application/vnd.lime.ping+json", resource: {} });
      }
      this.onCommand(command);
    } else this.onSession(envelope as Session);
  }
  private normalized(message: Message): Message {
    return { ...message, from: message.from || this.remoteNode, to: message.to || this.localNode };
  }
  sendMessage(message: Message): void {
    this.requireEstablished();
    if (this.version === 1) {
      if (message.stream !== undefined) throw new Error("LIME 1 does not support streaming");
      this.transport.send(message);
      return;
    }
    validateMessage(message);
    const recipient = message.to ? message.to.toString() : this.remoteNode || "";
    const initial = message.stream === undefined || message.stream === "start";
    // Reserve capacity before touching the stream or transport.
    if (initial) this.deliveries.add(message, recipient);
    try {
      const complete = this.outgoing.accept(message);
      if (complete && message.id) this.deliveries.complete(complete, recipient);
      this.transport.send(message);
    } catch (error) {
      this.deliveries.remove(message, recipient); this.outgoing.discard(message);
      this.scheduleRetries();
      throw error;
    }
    this.scheduleRetries();
  }
  get pendingMessageCount(): number { return this.deliveries.size; }
  get pendingCommandCount(): number { return this.commands.size; }
  get activeCommandCount(): number { return this.commandAssembly.size; }
  retryUnacknowledged(): void {
    this.requireEstablished();
    for (const entry of this.deliveries.values()) {
      if (!entry.complete || entry.attempts >= this.maxRetryAttempts) continue;
      entry.attempts++;
      try { this.transport.send(entry.message); }
      catch (error) { this.onDeliveryError(error as Error, entry.message); }
      if (this.deliveries.contains(entry) && entry.attempts === this.maxRetryAttempts) this.waitForFinalReceipt(entry);
    }
    this.scheduleRetries();
  }
  private waitForFinalReceipt(entry: PendingDelivery): void {
    // Sending the last retry is not evidence of failure: its receipt is asynchronous.
    const timer = setTimeout(() => {
      this.finalReceiptTimers.delete(entry);
      if (this.deliveries.contains(entry)) {
        this.onDeliveryError(new Error("Message retry limit reached; delivery remains unacknowledged"), entry.message);
      }
    }, this.retryInterval || 5000);
    this.finalReceiptTimers.set(entry, timer);
    (timer as any).unref?.();
  }
  private scheduleRetries(): void {
    for (const [entry, timer] of this.finalReceiptTimers) {
      if (!this.deliveries.contains(entry)) { clearTimeout(timer); this.finalReceiptTimers.delete(entry); }
    }
    const ready = !this.disposed && this.retryInterval && this.state === SessionState.ESTABLISHED &&
      this.deliveries.values().some(entry => entry.complete && entry.attempts < this.maxRetryAttempts);
    if (!ready) { clearTimeout(this.retryTimer); this.retryTimer = undefined; return; }
    if (this.retryTimer !== undefined) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = undefined; this.retryUnacknowledged(); }, this.retryInterval);
    // Pending delivery should not keep a Node process alive by itself.
    (this.retryTimer as any).unref?.();
  }
  processCommand(command: Command, timeout = this.commandTimeout): Promise<Command> {
    this.requireEstablished();
    if (typeof command.id !== "string" || !command.id || command.status) throw new Error("Command processing requires a request id");
    if (this.commands.has(command.id)) throw new Error("Command id is already pending");
    if (this.commands.size >= this.maxPendingCommands) throw new Error("Pending command capacity exceeded");
    if (!Number.isFinite(timeout) || timeout < 0 || timeout > 2147483647) throw new Error("Invalid command timeout");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.commands.delete(command.id);
        this.dropCommand(command, "outgoing");
        reject(new Error(`Command ${command.id} processing timed out; outcome is unconfirmed`));
      }, timeout);
      this.commands.set(command.id, { resolve, reject, timer, recipient: command.to ? command.to.toString() : this.remoteNode || "", method: command.method });
      try { this.sendCommand(command); }
      catch (error) { clearTimeout(timer); this.commands.delete(command.id); reject(error); }
    });
  }
  sendCommand(command: Command): void {
    this.requireEstablished();
    if (this.version === 1) {
      if (command.stream !== undefined) throw new Error("LIME 1 does not support command streaming");
      this.transport.send(command); return;
    }
    try {
      this.commandAssembly.accept(this.commandContext(command, "outgoing"), "outgoing");
      this.syncCommandTimer(command, "outgoing");
      this.transport.send(command);
    } catch (error) { this.dropCommand(command, "outgoing", error as Error); throw error; }
  }
  private normalizedCommand(command: Command): Command {
    return { ...command, from: command.from || this.remoteNode, to: this.localNode };
  }
  private commandContext(command: Command, direction: "incoming" | "outgoing"): Command {
    return direction === "incoming" ? this.normalizedCommand(command) : { ...command, from: this.localNode, to: command.to || this.remoteNode };
  }
  private commandTimerKey(command: Command, direction: "incoming" | "outgoing"): string {
    const value = this.commandContext(command, direction);
    return JSON.stringify([direction === "incoming" ? value.from : value.to?.toString(), command.id]);
  }
  private dropCommand(command: Command, direction: "incoming" | "outgoing", error?: Error): void {
    this.commandAssembly.discard(this.commandContext(command, direction), direction);
    const key = this.commandTimerKey(command, direction);
    clearTimeout(this.commandTimers.get(key)); this.commandTimers.delete(key);
    const peer = direction === "incoming" ? command.from || this.remoteNode : command.to?.toString() || this.remoteNode;
    const pending = this.commands.get(command.id);
    if (error && pending && pending.recipient === peer) {
      clearTimeout(pending.timer); this.commands.delete(command.id); pending.reject(error);
    }
  }
  private syncCommandTimer(command: Command, direction: "incoming" | "outgoing"): void {
    const key = this.commandTimerKey(command, direction);
    const context = this.commandContext(command, direction);
    if (!this.commandAssembly.has(context, direction)) {
      clearTimeout(this.commandTimers.get(key)); this.commandTimers.delete(key); return;
    }
    // A processCommand promise already owns an absolute request deadline.
    const peer = direction === "incoming" ? context.from : context.to?.toString();
    if (this.commands.get(command.id)?.recipient === peer || this.commandTimers.has(key)) return;
    const timer = setTimeout(() => {
      this.dropCommand(command, direction);
      this.onCommandError(new Error("Command exchange timed out; outcome is unconfirmed"), command);
    }, this.commandStreamTimeout);
    this.commandTimers.set(key, timer); (timer as any).unref?.();
  }
  sendNotification(notification: Notification): void {
    this.requireEstablished();
    if (this.version === 2) validateNotification(notification);
    this.transport.send(notification);
  }
  sendSession(session: Session): void {
    if (this.disposed || this.state === SessionState.FINISHED || this.state === SessionState.FAILED) throw new Error(`Cannot send in the '${this.state}' state`);
    this.transport.send(session);
  }
  protected resetSession(error = new Error("Session ended before command response")): void {
    clearTimeout(this.retryTimer);
    for (const timer of this.finalReceiptTimers.values()) clearTimeout(timer);
    this.finalReceiptTimers.clear();
    for (const timer of this.commandTimers.values()) clearTimeout(timer);
    this.commandTimers.clear();
    this.commandAssembly.reset();
    this.incoming.reset();
    this.outgoing.reset();
    this.contentTypes.reset();
    const pendingDeliveries = this.deliveries.values();
    this.deliveries.clear();
    for (const entry of this.commands.values()) { clearTimeout(entry.timer); entry.reject(error); }
    this.commands.clear();
    for (const entry of pendingDeliveries) this.onDeliveryError(error, entry.message);
  }
  dispose(): void {
    this.disposed = true;
    this.resetSession(new Error("Channel disposed"));
    this.transport.onEnvelope = () => {};
  }
  private requireEstablished(): void {
    if (this.disposed || this.state !== SessionState.ESTABLISHED) throw new Error(`Cannot send or receive in the '${this.state}' state`);
  }
  private notifyMessage(message: Message): void {
    if (this.autoNotifyReceipt && message.id && this.isForMe(message)) {
      const notification: Notification = { id: message.id, to: message.from || this.remoteNode, event: NotificationEvent.RECEIVED };
      if (this.version === 2 && message.rev !== undefined) notification.rev = message.rev;
      this.sendNotification(notification);
    }
  }
  protected isForMe(envelope: Envelope): boolean {
    if (!envelope.to) return true;
    const to = envelope.to.toString();
    return to === this.localNode || !!this.localNode && this.localNode.startsWith(to + "/");
  }
}
