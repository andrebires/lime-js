import * as Lime from '../../';
const transport: Lime.Transport = {
  onEnvelope() {}, open() { return Promise.resolve(); }, close() {}, send() {},
  getSupportedCompression() { return ['none']; }, setCompression() {}, compression: 'none',
  getSupportedEncryption() { return ['tls']; }, setEncryption() {}, encryption: 'tls'
};
const client = new Lime.ClientChannel(transport, true, undefined, { version: 2, maxPendingMessages: 4 });
const start: Lime.Message = { id: 'm', stream: Lime.MessageStream.START, type: 'text', rev: 2 };
client.sendMessage(start);
client.sendMessage({ id: 'm', stream: 'data', rev: 2, content: 'hello' });
client.sendMessage({ id: 'm', stream: 'end', rev: 2 });
const result: Promise<Lime.Command> = client.processCommand({id: 'c',method: Lime.CommandMethod.GET,uri: '/x'});
const session: Promise<Lime.Session> = client.establishSession();
client.sendNotification({ id: 'm', rev: 2, event: Lime.NotificationEvent.RECEIVED, scope: Lime.NotificationScope.SESSION });
client.onMessageProgress = value => console.log(value.stream);
client.contentTypes.register('card', 'application/vnd.example.card+json');
const content: Lime.AssemblyLimits = { maxStreams: 2, maxJsonDepth: 5 };
const assembler = new Lime.MessageAssembler(undefined, content);
const auth = new Lime.ExternalAuthentication('token', 'issuer');
const method: Lime.CommandMethod = 'merge';
void [result, session, assembler, auth, method];
