import Message from "./Message";
import { ContentTypeRegistry } from "../ContentTypes";
import { has, routingKey, validateMessage } from "./Validation";

export interface AssemblyLimits { maxStreams?: number; maxContentBytes?: number; maxJsonDepth?: number; }
interface Assembly { message: Message; text?: string[]; value?: any; bytes: number; }
const object = (value: any): boolean => value !== null && typeof value === "object" && !Array.isArray(value);
// Define properties explicitly: __proto__ is JSON data, never a prototype setter.
function set(target: any, key: string, value: any): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function copy(value: any, depth: number): any {
  if (depth < 0) throw new Error("JSON nesting limit exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => copy(item, depth - 1));
  if (!object(value) || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) throw new Error("Content must be a JSON value");
  const result: any = {};
  for (const key of Object.keys(value)) set(result, key, copy(value[key], depth - 1));
  return result;
}
function patch(target: any, value: any): any {
  if (!object(value)) return value;
  if (!object(target)) target = {};
  for (const key of Object.keys(value)) {
    if (value[key] === null) delete target[key];
    else set(target, key, patch(has(target, key) ? target[key] : undefined, value[key]));
  }
  return target;
}
export default class MessageAssembler {
  private streams = new Map<string, Assembly>();
  readonly maxStreams: number;
  readonly maxContentBytes: number;
  readonly maxJsonDepth: number;
  constructor(private registry = new ContentTypeRegistry(), limits: AssemblyLimits = {}) {
    this.maxStreams = limits.maxStreams ?? 64;
    this.maxContentBytes = limits.maxContentBytes ?? 1048576;
    this.maxJsonDepth = limits.maxJsonDepth ?? 64;
    for (const value of [this.maxStreams, this.maxContentBytes, this.maxJsonDepth]) {
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
      this.streams.set(key, { message: { ...message, type }, text: mime === "text/plain" ? [] : undefined, value: {}, bytes: 0 });
      return;
    }
    const assembly = this.streams.get(key);
    if (!assembly) throw new Error("Stream has not started in this session");
    if (message.thread !== undefined && message.thread !== assembly.message.thread) throw new Error("Stream thread mismatch");
    if (message.stream === "data") {
      const { value, bytes } = this.content(message.content, assembly.message.type);
      if (assembly.bytes + bytes > this.maxContentBytes) throw new Error("Stream content limit exceeded");
      if (assembly.text) assembly.text.push(value);
      else assembly.value = patch(assembly.value, value);
      assembly.bytes += bytes;
      return;
    }
    this.streams.delete(key);
    const { stream, ...complete } = assembly.message;
    return { ...complete, content: assembly.text ? assembly.text.join("") : assembly.value };
  }
  private content(value: any, type: string): { value: any; bytes: number } {
    const result = copy(value, this.maxJsonDepth);
    if (type.split(";")[0].toLowerCase() === "text/plain" && typeof result !== "string") throw new Error("Text content must be a string");
    const encoded = JSON.stringify(result);
    let bytes = encoded.length;
    for (let index = 0; index < encoded.length; index++) {
      const code = encoded.charCodeAt(index);
      if (code >= 0x80 && code < 0x800) bytes++;
      else if (code >= 0xd800 && code <= 0xdbff && index + 1 < encoded.length &&
          encoded.charCodeAt(index + 1) >= 0xdc00 && encoded.charCodeAt(index + 1) <= 0xdfff) {
        bytes += 2;
        index++;
      } else if (code >= 0x800) bytes += 2;
    }
    if (bytes > this.maxContentBytes) throw new Error("Message content limit exceeded");
    return { value: result, bytes };
  }
}
