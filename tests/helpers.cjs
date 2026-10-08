const Lime = require('../dist/lime.js');
class FakeTransport {
  sent = [];
  compression = 'none';
  encryption = 'none';
  closed = 0;
  onEnvelope = () => {};
  send(envelope) { if (this.failSend) throw new Error('Transport send failed'); this.sent.push(envelope); this.respond?.(envelope); }
  close() { this.closed++; return this.closeResult; }
  setCompression(value) { this.compression = value; }
  setEncryption(value) { this.encryption = value; }
  receive(envelope) { this.onEnvelope(envelope); }
}
function channel(options = {}, receipt) {
  const transport = new FakeTransport();
  const client = new Lime.ClientChannel(transport, true, receipt, { retryInterval: 0, ...options });
  const messages = [], progress = [], notifications = [], errors = [], deliveries = [], commands = [];
  client.onMessage = message => messages.push(message);
  client.onMessageProgress = message => progress.push(message);
  client.onNotification = value => notifications.push(value);
  client.onCommand = value => commands.push(value);
  client.onProtocolError = (error, envelope) => errors.push({ error, envelope });
  client.onDeliveryError = (error, message) => deliveries.push({ error, message });
  client.onSession({ state: 'established', id: 's', from: 'server@example', to: 'client@example/browser' });
  return { client, transport, messages, progress, notifications, errors, deliveries, commands };
}
module.exports = { Lime, FakeTransport, channel };
