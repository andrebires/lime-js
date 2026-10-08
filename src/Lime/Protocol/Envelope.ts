import Identity from "./Identity";
import Node from "./Node";

interface Envelope {
  id?: string;
  from?: string;
  to?: string | Node | Identity;
  pp?: string;
  metadata?: any;
}
const has = (value: Envelope, key: string): boolean =>
  value != null && Object.prototype.hasOwnProperty.call(value, key);
const Envelope = {
  isMessage: (value: Envelope) => has(value, "content") || (has(value, "stream") && !has(value, "method") && !has(value, "event") && !has(value, "state")),
  isNotification: (value: Envelope) => has(value, "event"),
  isCommand: (value: Envelope) => has(value, "method"),
  isSession: (value: Envelope) => has(value, "state")
};
export interface EnvelopeListener { onEnvelope(envelope: Envelope): void; }
export default Envelope;
