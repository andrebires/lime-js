import Message from "./Message";
import Notification from "./Notification";
export const has = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);
export function revision(value: { rev?: number }): number {
  const rev = value.rev === undefined ? 1 : value.rev;
  if (!Number.isSafeInteger(rev) || rev < 1) throw new Error("Revision must be a positive safe integer");
  return rev;
}
export function validateMessage(message: Message): void {
  revision(message);
  if (message.thread !== undefined && (typeof message.thread !== "string" || !message.thread)) throw new Error("Invalid thread");
  if (message.id !== undefined && (typeof message.id !== "string" || !message.id)) throw new Error("Invalid message id");
  if (message.stream === undefined) {
    if (!has(message, "content") || typeof message.type !== "string" || !message.type) throw new Error("Complete message requires type and content");
    return;
  }
  if (!message.id) throw new Error("Streaming requires a message id");
  switch (message.stream) {
    case "start":
      if (typeof message.type !== "string" || !message.type || has(message, "content")) throw new Error("Stream start requires type and no content");
      break;
    case "data":
      if (!has(message, "content") || has(message, "type")) throw new Error("Stream data requires content and no type");
      break;
    case "end":
      if (has(message, "content") || has(message, "type")) throw new Error("Stream end cannot contain type or content");
      break;
    default: throw new Error("Unknown stream signal");
  }
}
export function validateNotification(notification: Notification): void {
  revision(notification);
  if (typeof notification.id !== "string" || !notification.id) throw new Error("Notification requires an id");
  const scope = notification.scope === undefined ? "message" : notification.scope;
  const allowed = notification.event === "received" ? ["message", "session"] :
    notification.event === "consumed" ? ["message", "thread"] : notification.event === "failed" ? ["message"] : [];
  if (!allowed.includes(scope)) throw new Error("Invalid notification event/scope");
  if (scope === "thread" && (typeof notification.thread !== "string" || !notification.thread)) throw new Error("Thread scope requires thread");
  if (notification.event === "failed" && (!notification.reason || !Number.isInteger(notification.reason.code) ||
      (notification.reason.description !== undefined && typeof notification.reason.description !== "string"))) throw new Error("Failure requires a LIME reason");
}
export function routingKey(message: { id?: string; rev?: number; from?: string; to?: any }): string {
  return JSON.stringify([message.from || "", message.to ? message.to.toString() : "", message.id, revision(message)]);
}
