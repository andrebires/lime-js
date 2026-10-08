import Message from "../Message";
import Notification from "../Notification";
import { revision } from "../Validation";
export interface PendingDelivery { message: Message; complete: boolean; attempts: number; recipient: string; position: number; }
export default class DeliveryBuffer {
  private entries = new Map<string, PendingDelivery>();
  private acknowledged = new Map<string, { thread?: string; position: number }>();
  private nextPosition = 0;
  constructor(private capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) throw new Error("Pending message capacity must be positive");
  }
  private key(id: string, rev: number, recipient: string): string { return JSON.stringify([recipient, id, rev]); }
  get size(): number { return this.entries.size; }
  values(): PendingDelivery[] { return Array.from(this.entries.values()); }
  clear(): void { this.entries.clear(); this.acknowledged.clear(); }
  contains(entry: PendingDelivery): boolean { return this.entries.get(this.key(entry.message.id, revision(entry.message), entry.recipient)) === entry; }
  private remember(key: string, entry: PendingDelivery): void {
    this.acknowledged.set(key, { thread: entry.message.thread, position: entry.position });
    if (this.acknowledged.size > this.capacity * 4) this.acknowledged.delete(this.acknowledged.keys().next().value);
  }
  add(message: Message, recipient: string): void {
    if (!message.id) return;
    const key = this.key(message.id, revision(message), recipient);
    if (this.acknowledged.has(key)) throw new Error("Message revision was already acknowledged");
    if (this.entries.has(key)) throw new Error("Message revision is already pending; use retryUnacknowledged");
    if (this.entries.size >= this.capacity) throw new Error("Unacknowledged message capacity exceeded");
    this.entries.set(key, { message: { ...message }, complete: message.stream === undefined, attempts: 0, recipient, position: this.nextPosition++ });
  }
  complete(message: Message, recipient: string): void {
    const entry = this.entries.get(this.key(message.id, revision(message), recipient));
    if (!entry) throw new Error("Stream has no pending delivery");
    entry.message = message;
    entry.complete = true;
  }
  remove(message: Message, recipient: string): void { this.entries.delete(this.key(message.id, revision(message), recipient)); }
  acknowledge(notification: Notification, recipient: string): void {
    const marker = this.key(notification.id, revision(notification), recipient);
    const entry = this.entries.get(marker);
    const acknowledged = this.acknowledged.get(marker);
    if (!entry && !acknowledged) throw new Error("Unresolved receipt marker");
    if (notification.event !== "failed" && entry && !entry.complete) throw new Error("Incomplete receipt marker");
    const thread = entry ? entry.message.thread : acknowledged.thread;
    const position = entry ? entry.position : acknowledged.position;
    if (notification.thread !== undefined && notification.thread !== thread) throw new Error("Receipt thread mismatch");
    if (notification.event !== "received") return;
    if (notification.scope !== "session") {
      if (entry) this.remember(marker, entry);
      this.entries.delete(marker);
      return;
    }
    const prefix: string[] = [];
    for (const [key, pending] of this.entries) {
      if (pending.recipient !== recipient || pending.position > position) continue;
      if (!pending.complete) throw new Error("Session receipt crosses an incomplete message");
      prefix.push(key);
    }
    for (const key of prefix) { this.remember(key, this.entries.get(key)); this.entries.delete(key); }
  }
}
