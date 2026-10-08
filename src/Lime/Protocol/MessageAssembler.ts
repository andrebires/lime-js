import Message from "./Message";
import JsonPatchDocument, { jsonBytes, copyJsonValue } from "./JsonPatch";
import { ContentTypeRegistry } from "../ContentTypes";
import { routingKey, validateMessage } from "./Validation";

export interface AssemblyLimits { maxStreams?: number; maxContentBytes?: number; maxJsonDepth?: number; maxPatchOperations?: number; }
interface Assembly { message: Message; text?: string[]; value?: JsonPatchDocument; bytes: number; }
export default class MessageAssembler {
  private streams = new Map<string, Assembly>();
  readonly maxStreams: number;
  readonly maxContentBytes: number;
  readonly maxJsonDepth: number;
  readonly maxPatchOperations: number;
  constructor(private registry = new ContentTypeRegistry(), limits: AssemblyLimits = {}) {
    this.maxStreams = limits.maxStreams ?? 64;
    this.maxContentBytes = limits.maxContentBytes ?? 1048576;
    this.maxJsonDepth = limits.maxJsonDepth ?? 64;
    this.maxPatchOperations = limits.maxPatchOperations ?? 256;
    for (const value of [this.maxStreams, this.maxContentBytes, this.maxJsonDepth, this.maxPatchOperations]) {
      if (!Number.isSafeInteger(value) || value < 1) throw new Error("Assembly limits must be positive safe integers");
    }
  }
  reset(): void { this.streams.clear(); }
  discard(message: Message): void { this.streams.delete(routingKey(message)); }
  accept(message: Message): Message | undefined {
    validateMessage(message);
    if (message.stream === undefined) {
      const type = this.registry.resolve(message.type);
      const { value: content } = this.content(message.content, type);
      if (this.streams.size) this.streams.delete(routingKey(message));
      return { ...message, type, content };
    }
    const key = routingKey(message);
    if (message.stream === "start") {
      if (this.streams.has(key)) throw new Error("Stream already started");
      if (this.streams.size >= this.maxStreams) throw new Error("Active stream capacity exceeded");
      const type = this.registry.resolve(message.type);
      const mime = type.split(";")[0].toLowerCase();
      if (mime !== "text/plain" && mime !== "application/json" && !mime.endsWith("+json")) throw new Error("Unsupported streaming content type");
      this.streams.set(key, { message: { ...message, type }, text: mime === "text/plain" ? [] : undefined, value: mime === "text/plain" ? undefined : new JsonPatchDocument(copyJsonValue, this.maxJsonDepth, this.maxContentBytes), bytes: 0 });
      return;
    }
    const assembly = this.streams.get(key);
    if (!assembly) throw new Error("Stream has not started in this session");
    if (message.thread !== undefined && message.thread !== assembly.message.thread) throw new Error("Stream thread mismatch");
    if (message.stream === "data") {
      const { value, bytes } = this.content(message.content, assembly.message.type, assembly.text ? 0 : 2);
      if (assembly.bytes + bytes > this.maxContentBytes) throw new Error("Stream content limit exceeded");
      if (assembly.text) assembly.text.push(value);
      else {
        try { assembly.bytes += assembly.value.apply(value, this.maxPatchOperations, this.maxContentBytes - assembly.bytes - bytes); }
        catch (error) { this.streams.delete(key); throw error; }
      }
      assembly.bytes += bytes;
      return;
    }
    this.streams.delete(key);
    if (!assembly.text && assembly.value.value === undefined) throw new Error("JSON Patch removed the root without replacing it");
    const { stream, ...complete } = assembly.message;
    return { ...complete, content: assembly.text ? assembly.text.join("") : assembly.value.value };
  }
  private content(value: any, type: string, wrapperDepth = 0): { value: any; bytes: number } {
    const result = copyJsonValue(value, this.maxJsonDepth + wrapperDepth);
    if (type.split(";")[0].toLowerCase() === "text/plain" && typeof result !== "string") throw new Error("Text content must be a string");
    const bytes = jsonBytes(result);
    if (bytes > this.maxContentBytes) throw new Error("Message content limit exceeded");
    return { value: result, bytes };
  }
}
