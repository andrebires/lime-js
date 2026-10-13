// Lime slim client: the smallest entry point for a browser conversation client.
// It carries the LIME 2 client channel and the WebSocket transport only; use the
// full entry point for identities, authentication classes, content type tables
// and the stand-alone assemblers.
export { default as ClientChannel } from "./Protocol/Client/ClientChannel";
export { default as WebSocketTransport } from "./Protocol/Network/WebSocketTransport";
export type { WebSocketTransportOptions, WebSocketLike, WebSocketFactory, WebSocketClose } from "./Protocol/Network/WebSocketTransport";
export type { ChannelOptions } from "./Protocol/Client/Channel";
export type { default as Transport } from "./Protocol/Network/Transport";
export type { default as Envelope } from "./Protocol/Envelope";
export type { default as Message, MessageStream } from "./Protocol/Message";
export type { default as Notification, NotificationEvent, NotificationScope } from "./Protocol/Notification";
export type { default as Command, CommandMethod, CommandStatus, CommandStream } from "./Protocol/Command";
export type { default as Session, SessionState, SessionCompression, SessionEncryption } from "./Protocol/Session";
export type { default as Reason } from "./Protocol/Reason";
