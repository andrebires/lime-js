import Envelope from "./Envelope";
import Reason from "./Reason";

interface Command extends Envelope {
  stream?: CommandStream;
  uri?: string;
  type?: string;
  resource?: any;
  method: CommandMethod;
  status?: CommandStatus;
  reason?: Reason;
}
export default Command;

export interface CommandListener {
  onCommand(command: Command): void;
}

export const CommandMethod = {
  GET: <CommandMethod> "get",
  SET: <CommandMethod> "set",
  DELETE: <CommandMethod> "delete",
  OBSERVE: <CommandMethod> "observe",
  SUBSCRIBE: <CommandMethod> "subscribe",
  UNSUBSCRIBE: <CommandMethod> "unsubscribe",
  MERGE: <CommandMethod> "merge",
}
export type CommandMethod
  = "get"
  | "set"
  | "delete"
  | "observe"
  | "subscribe"
  | "unsubscribe"
  | "merge"
  ;

export const CommandStatus = {
  SUCCESS: <CommandStatus> "success",
  FAILURE: <CommandStatus> "failure"
}
export type CommandStatus
  = "success"
  | "failure"
  ;

export type CommandStream = "start" | "data" | "end";
export const CommandStream = { START: "start" as CommandStream, DATA: "data" as CommandStream, END: "end" as CommandStream };
