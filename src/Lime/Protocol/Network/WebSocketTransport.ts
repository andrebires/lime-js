import Envelope from "../Envelope";
import { SessionCompression, SessionEncryption } from "../Session";
import Transport from "./Transport";

/** The subset of the browser WebSocket API the transport uses. */
export interface WebSocketLike {
  readonly readyState: number;
  readonly protocol: string;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code: number; reason: string; wasClean: boolean }) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

/** Creates a socket; the default is the global `WebSocket`. */
export type WebSocketFactory = new (url: string, protocols?: string | string[]) => WebSocketLike;

/** Options for {@link WebSocketTransport}. */
export interface WebSocketTransportOptions {
  /** Subprotocols offered in the handshake. The server must select the first one. Default `["lime"]`. */
  protocols?: string[];
  /** Largest frame, in UTF-8 bytes, sent or accepted. Default 65536. */
  maxFrameBytes?: number;
  /** Socket constructor, for tests or non-browser runtimes. */
  WebSocket?: WebSocketFactory;
}

/** Why the socket closed, as reported by the browser. */
export interface WebSocketClose { code: number; reason: string; wasClean: boolean; }

const OPEN = 1;

/**
 * A LIME transport over one WebSocket: one JSON envelope per text frame, in
 * order. It does not reconnect; a new connection needs a new transport and a
 * new channel.
 */
export default class WebSocketTransport implements Transport {
  /** Receives every parsed envelope, in frame order. Set by the channel. */
  onEnvelope: (envelope: Envelope) => void = () => {};
  /** Called once when the socket closes, after a successful open. */
  onClose: (event: WebSocketClose) => void = () => {};
  /** Called when the peer sends a frame the transport cannot accept; the socket is then closed. */
  onError: (error: Error) => void = () => {};
  compression: SessionCompression = "none";
  encryption: SessionEncryption = "none";
  private socket: WebSocketLike;
  private readonly protocols: string[];
  private readonly maxFrame: number;
  private readonly factory: WebSocketFactory;

  constructor(options: WebSocketTransportOptions = {}) {
    this.protocols = options.protocols ?? ["lime"];
    this.maxFrame = options.maxFrameBytes ?? 65536;
    if (!Number.isSafeInteger(this.maxFrame) || this.maxFrame < 1) throw new Error("Invalid frame limit");
    this.factory = options.WebSocket ?? (globalThis as any).WebSocket;
    if (!this.factory) throw new Error("WebSocket is not available");
  }

  /** Opens the socket and resolves once the server accepted the LIME subprotocol. */
  open(uri: string): Promise<void> {
    if (this.socket) return Promise.reject(new Error("Transport already opened"));
    this.encryption = /^wss:/i.test(uri) ? "tls" : "none";
    return new Promise((resolve, reject) => {
      let opened = false;
      const socket = this.socket = new this.factory(uri, this.protocols);
      socket.onopen = () => {
        if (this.protocols.length && socket.protocol !== this.protocols[0]) {
          socket.close(4002, "subprotocol");
          reject(new Error("Server did not select the LIME subprotocol"));
          return;
        }
        opened = true;
        resolve();
      };
      socket.onerror = () => { /* The close event that follows carries the outcome. */ };
      socket.onclose = event => {
        socket.onopen = socket.onclose = socket.onmessage = socket.onerror = null;
        if (!opened) { reject(new Error(`WebSocket closed before opening (${event.code})`)); return; }
        this.onClose({ code: event.code, reason: event.reason, wasClean: event.wasClean });
      };
      socket.onmessage = event => this.receive(event.data);
    });
  }

  /** Sends one envelope as one text frame. Throws unless the socket is open. */
  send(envelope: Envelope): void {
    if (!this.socket || this.socket.readyState !== OPEN) throw new Error("WebSocket is not open");
    const data = JSON.stringify(envelope);
    if (utf8Exceeds(data, this.maxFrame)) throw new Error("Frame limit exceeded");
    this.socket.send(data);
  }

  /** Closes the socket. Resolves immediately; `onClose` reports the outcome. */
  close(): Promise<void> {
    this.socket?.close(1000);
    return Promise.resolve();
  }

  getSupportedCompression(): SessionCompression[] { return ["none"]; }
  setCompression(compression: SessionCompression): void {
    if (compression !== "none") throw new Error("Unsupported compression");
  }
  getSupportedEncryption(): SessionEncryption[] { return [this.encryption]; }
  setEncryption(encryption: SessionEncryption): void {
    if (encryption !== this.encryption) throw new Error("Unsupported encryption");
  }

  private receive(data: unknown): void {
    if (typeof data !== "string") { this.fail(4003, new Error("LIME requires text frames")); return; }
    if (utf8Exceeds(data, this.maxFrame)) { this.fail(4009, new Error("Frame limit exceeded")); return; }
    let envelope: Envelope;
    try {
      envelope = JSON.parse(data);
    } catch {
      this.fail(4007, new Error("Invalid JSON frame")); return;
    }
    if (envelope === null || typeof envelope !== "object" || Array.isArray(envelope)) {
      this.fail(4007, new Error("Frame is not an envelope")); return;
    }
    this.onEnvelope(envelope);
  }

  private fail(code: number, error: Error): void {
    this.onError(error);
    this.socket.close(code);
  }
}

/** Reports whether the UTF-8 encoding of s is longer than max bytes, without encoding it. */
function utf8Exceeds(s: string, max: number): boolean {
  if (s.length > max) return true; // Every code unit is at least one byte.
  if (s.length * 3 <= max) return false; // Every code unit is at most three bytes.
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && (s.charCodeAt(i + 1) & 0xfc00) === 0xdc00) { bytes += 4; i++; }
    else bytes += 3;
    if (bytes > max) return true;
  }
  return false;
}
