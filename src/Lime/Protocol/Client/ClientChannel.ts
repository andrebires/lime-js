import Message from "../Message";
import Notification from "../Notification";
import Command from "../Command";
import Session, { SessionCompression, SessionEncryption, SessionState } from "../Session";
import Channel, { ChannelOptions } from "./Channel";
import Transport from "../Network/Transport";
import Authentication from "../Security/Authentication";
interface SessionWaiter { resolve: (session: Session) => void; reject: (error: any) => void; states: SessionState[]; timer: ReturnType<typeof setTimeout>; }
export default class ClientChannel extends Channel {
  private waiter: SessionWaiter;
  private readonly sessionTimeout: number;
  constructor(transport: Transport, autoReplyPings = true, autoNotifyReceipt?: boolean, options: ChannelOptions = {}) {
    super(transport, autoReplyPings, autoNotifyReceipt, options);
    this.sessionTimeout = options.sessionTimeout ?? 10000;
    if (!Number.isSafeInteger(this.sessionTimeout) || this.sessionTimeout < 1 || this.sessionTimeout > 2147483647) throw new Error("Invalid session timeout");
  }
  async establishSession(compression?: SessionCompression, encryption?: SessionEncryption, identity?: string, authentication?: Authentication, instance?: string): Promise<Session> {
    let session = await this.startNewSession();
    if (session.state === SessionState.NEGOTIATING) {
      session = await this.negotiateSession(compression ?? session.compressionOptions?.[0], encryption ?? session.encryptionOptions?.[0]);
    }
    this.applyTransportOptions(session);
    if (session.state === SessionState.AUTHENTICATING) session = await this.authenticateSession(identity, authentication, instance);
    return session;
  }
  onMessage(message: Message): void {}
  onNotification(notification: Notification): void {}
  onCommand(command: Command): void {}
  onSessionFinished(session: Session): void {}
  onSessionFailed(session: Session): void {}
  onSession(session: Session): void {
    if (!Object.values(SessionState).includes(session.state)) { this.onProtocolError(new Error("Unknown session state"), session); return; }
    if (session.state === SessionState.ESTABLISHED && (typeof session.id !== "string" || !session.id)) { this.onProtocolError(new Error("Established session requires a server-issued id"), session); return; }
    if (session.version !== undefined && session.version !== this.version) { this.onProtocolError(new Error("Session version mismatch"), session); return; }
    if (this.state === SessionState.FINISHED || this.state === SessionState.FAILED) {
      this.onProtocolError(new Error("Session is already terminal"), session); return;
    }
    if (this.version === 2) {
      const allowed = this.state === SessionState.NEW || this.state === SessionState.NEGOTIATING ?
        [SessionState.NEGOTIATING, SessionState.AUTHENTICATING, SessionState.ESTABLISHED, SessionState.FAILED, SessionState.FINISHED] :
        this.state === SessionState.AUTHENTICATING ? [SessionState.AUTHENTICATING, SessionState.ESTABLISHED, SessionState.FAILED, SessionState.FINISHED] :
        [SessionState.FINISHING, SessionState.FINISHED, SessionState.FAILED];
      if (!allowed.includes(session.state)) { this.onProtocolError(new Error("Unexpected session transition"), session); return; }
      if (session.id !== undefined && this.sessionId && session.id !== this.sessionId) {
        this.onProtocolError(new Error("Session id mismatch"), session); return;
      }
    }
    try { this.applyTransportOptions(session); }
    catch (error) { this.failSession(error as Error, session); this.onProtocolError(error as Error, session); return; }
    this.sessionId = session.id ?? this.sessionId;
    this.state = session.state;
    if (session.state === SessionState.ESTABLISHED) {
      this.localNode = session.to?.toString();
      this.remoteNode = session.from;
    }
    const waiter = this.waiter;
    if (waiter && (waiter.states.includes(session.state) || session.state === SessionState.FAILED || session.state === SessionState.FINISHED)) clearTimeout(waiter.timer);
    if (session.state === SessionState.FAILED || session.state === SessionState.FINISHED) {
      this.waiter = undefined;
      if (waiter) {
        if (session.state === SessionState.FAILED) waiter.reject(session);
        else if (waiter.states.includes(session.state)) waiter.resolve(session);
        else waiter.reject(new Error("Session finished before establishment"));
      }
      try { this.resetSession(); } finally { this.closeTransport(session); }
      if (session.state === SessionState.FAILED) this.onSessionFailed(session);
      else this.onSessionFinished(session);
    } else if (waiter?.states.includes(session.state)) {
      this.waiter = undefined;
      waiter.resolve(session);
    }
  }
  startNewSession(): Promise<Session> {
    this.requireState(SessionState.NEW);
    const session: Session = { state: SessionState.NEW };
    if (this.version === 2) session.version = 2;
    return this.exchange(session, [SessionState.NEGOTIATING, SessionState.AUTHENTICATING, SessionState.ESTABLISHED]);
  }
  negotiateSession(compression: SessionCompression, encryption: SessionEncryption): Promise<Session> {
    this.requireState(SessionState.NEGOTIATING);
    const session: Session = { id: this.sessionId, state: SessionState.NEGOTIATING };
    if (compression !== undefined) session.compression = compression;
    if (encryption !== undefined) session.encryption = encryption;
    return this.exchange(session, [SessionState.AUTHENTICATING, SessionState.ESTABLISHED]);
  }
  authenticateSession(identity: string, authentication: Authentication, instance?: string): Promise<Session> {
    this.requireState(SessionState.AUTHENTICATING);
    if (!identity || !authentication?.scheme) throw new Error("Session authentication requires identity and authentication");
    return this.exchange({ id: this.sessionId, state: SessionState.AUTHENTICATING,
      from: instance ? `${identity}/${instance}` : identity, scheme: authentication.scheme, authentication }, [SessionState.ESTABLISHED]);
  }
  sendFinishingSession(): Promise<Session> {
    this.requireState(SessionState.ESTABLISHED);
    return this.exchange({ id: this.sessionId, state: SessionState.FINISHING }, [SessionState.FINISHED]);
  }
  dispose(): void {
    if (this.waiter) { clearTimeout(this.waiter.timer); this.waiter.reject(new Error("Channel disposed")); }
    this.waiter = undefined;
    super.dispose();
  }
  private exchange(session: Session, states: SessionState[]): Promise<Session> {
    if (this.waiter) throw new Error("A session exchange is already pending");
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.failSession(new Error("Session exchange timed out"), session), this.sessionTimeout);
      this.waiter = { resolve, reject, states, timer };
      try { this.sendSession(session); }
      catch (error) { clearTimeout(timer); this.waiter = undefined; reject(error); }
    });
  }
  private failSession(error: Error, session: Session): void {
    this.state = SessionState.FAILED;
    const waiter = this.waiter;
    this.waiter = undefined;
    if (waiter) { clearTimeout(waiter.timer); waiter.reject(error); }
    try { this.resetSession(error); } finally { this.closeTransport(session); }
  }
  private closeTransport(session: Session): void {
    // A close failure cannot strand a settled session promise.
    try { Promise.resolve(this.transport.close()).catch(error => this.onProtocolError(error, session)); }
    catch (error) { this.onProtocolError(error as Error, session); }
  }
  private requireState(state: SessionState): void {
    if (this.state !== state) throw new Error(`Cannot exchange session in the '${this.state}' state`);
  }
  private applyTransportOptions(session: Session): void {
    if (session.compression !== undefined && session.compression !== this.transport.compression) this.transport.setCompression(session.compression);
    if (session.encryption !== undefined && session.encryption !== this.transport.encryption) this.transport.setEncryption(session.encryption);
  }
}
