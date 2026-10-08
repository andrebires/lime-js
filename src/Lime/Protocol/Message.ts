import Envelope from "./Envelope";
export type MessageStream = "start" | "data" | "end";
export const MessageStream = { START: "start", DATA: "data", END: "end" } as const;
interface Message extends Envelope {
  type?: string;
  content?: any;
  rev?: number;
  thread?: string;
  stream?: MessageStream;
}
export default Message;
export interface MessageListener { onMessage(message: Message): void; }
