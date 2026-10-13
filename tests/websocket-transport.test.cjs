const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Lime } = require('./helpers.cjs');

class FakeSocket {
  static last;
  readyState = 0; protocol = ''; sent = []; closed;
  onopen = null; onclose = null; onmessage = null; onerror = null;
  constructor(url, protocols) { this.url = url; this.protocols = protocols; FakeSocket.last = this; }
  send(data) { this.sent.push(data); }
  close(code) { this.closed = code; }
  accept(protocol = 'lime') { this.protocol = protocol; this.readyState = 1; this.onopen?.({}); }
  drop(code = 1006, wasClean = false) { this.readyState = 3; this.onclose?.({ code, reason: '', wasClean }); }
  frame(data) { this.onmessage?.({ data }); }
}
const make = (options = {}) => new Lime.WebSocketTransport({ WebSocket: FakeSocket, ...options });

test('open offers the lime subprotocol and resolves once it is selected', async () => {
  const transport = make();
  const opened = transport.open('wss://example/lime?token=t');
  const socket = FakeSocket.last;
  assert.deepEqual(socket.protocols, ['lime']);
  assert.equal(transport.encryption, 'tls');
  socket.accept();
  await opened;
  await assert.rejects(transport.open('wss://example/lime'), /already opened/);
});

test('open rejects when the server selects another subprotocol or closes first', async () => {
  const wrong = make(); const first = wrong.open('ws://example');
  assert.equal(wrong.encryption, 'none');
  FakeSocket.last.accept('');
  await assert.rejects(first, /subprotocol/);
  assert.equal(FakeSocket.last.closed, 4002);
  const refused = make(); const second = refused.open('ws://example');
  FakeSocket.last.drop(1006);
  await assert.rejects(second, /closed before opening \(1006\)/);
});

test('send writes one JSON text frame per envelope and enforces state and size', async () => {
  const transport = make({ maxFrameBytes: 40 });
  assert.throws(() => transport.send({ id: 'x' }), /not open/);
  const opened = transport.open('ws://example'); FakeSocket.last.accept(); await opened;
  transport.send({ state: 'new', version: 2 });
  assert.deepEqual(FakeSocket.last.sent, ['{"state":"new","version":2}']);
  assert.throws(() => transport.send({ id: 'm', type: 'text/plain', content: 'x'.repeat(40) }), /Frame limit/);
});

test('frame limits count UTF-8 bytes, not UTF-16 code units', async () => {
  const transport = make({ maxFrameBytes: 64 });
  const errors = []; transport.onError = e => errors.push(e.message);
  const opened = transport.open('ws://example'); const socket = FakeSocket.last; socket.accept(); await opened;
  // 20 characters of three bytes each, plus JSON framing: 70 bytes but 30 code units.
  assert.throws(() => transport.send({ id: 'é', type: 'text/plain', content: '€'.repeat(20) }), /Frame limit/);
  transport.send({ content: '€'.repeat(10) }); // 41 bytes.
  socket.frame('"' + '😀'.repeat(16) + '"'); // 66 bytes, 34 code units.
  assert.equal(socket.closed, 4009);
  assert.deepEqual(errors, ['Frame limit exceeded']);
});

test('received frames become envelopes in order; bad frames report and close', async () => {
  const transport = make({ maxFrameBytes: 64 });
  const envelopes = [], errors = [];
  transport.onEnvelope = e => envelopes.push(e); transport.onError = e => errors.push(e.message);
  const opened = transport.open('ws://example'); const socket = FakeSocket.last; socket.accept(); await opened;
  socket.frame('{"id":"1","event":"received"}'); socket.frame('{"id":"2","event":"received"}');
  assert.deepEqual(envelopes.map(e => e.id), ['1', '2']);
  socket.frame(new ArrayBuffer(2)); assert.equal(socket.closed, 4003);
  socket.frame('{'); assert.equal(socket.closed, 4007);
  socket.frame('[1]'); socket.frame('null');
  socket.frame('"' + 'x'.repeat(80) + '"'); assert.equal(socket.closed, 4009);
  assert.deepEqual(errors, ['LIME requires text frames', 'Invalid JSON frame', 'Frame is not an envelope', 'Frame is not an envelope', 'Frame limit exceeded']);
  assert.equal(envelopes.length, 2);
});

test('close reports the outcome once through onClose', async () => {
  const transport = make(); const closes = [];
  transport.onClose = e => closes.push(e);
  await transport.close();
  const opened = transport.open('ws://example'); const socket = FakeSocket.last; socket.accept(); await opened;
  await transport.close(); assert.equal(socket.closed, 1000);
  socket.drop(1000, true); socket.drop(1000, true);
  assert.deepEqual(closes, [{ code: 1000, reason: '', wasClean: true }]);
});

test('only plain compression and the URL encryption are supported', () => {
  const transport = make();
  assert.deepEqual(transport.getSupportedCompression(), ['none']);
  transport.setCompression('none'); assert.throws(() => transport.setCompression('gzip'), /Unsupported/);
  assert.deepEqual(transport.getSupportedEncryption(), ['none']);
  transport.setEncryption('none'); assert.throws(() => transport.setEncryption('tls'), /Unsupported/);
});

test('constructor validates limits and requires a WebSocket implementation', () => {
  assert.throws(() => make({ maxFrameBytes: 0 }), /Invalid frame limit/);
  const saved = globalThis.WebSocket;
  try { delete globalThis.WebSocket; assert.throws(() => new Lime.WebSocketTransport(), /not available/); }
  finally { if (saved) globalThis.WebSocket = saved; }
  globalThis.WebSocket = FakeSocket;
  try { new Lime.WebSocketTransport().open('ws://example'); assert.ok(FakeSocket.last instanceof FakeSocket); }
  finally { if (saved) globalThis.WebSocket = saved; else delete globalThis.WebSocket; }
});

test('slim ESM build establishes a transport-identity session in one round trip', async () => {
  const slim = await import('../dist/lime-slim.mjs');
  assert.deepEqual(Object.keys(slim).sort(), ['ClientChannel', 'WebSocketTransport']);
  const transport = new slim.WebSocketTransport({ WebSocket: FakeSocket });
  const opened = transport.open('ws://example'); const socket = FakeSocket.last; socket.accept(); await opened;
  const client = new slim.ClientChannel(transport, true, true, { retryInterval: 0 });
  const established = client.establishSession();
  assert.deepEqual(JSON.parse(socket.sent[0]), { state: 'new', version: 2 });
  socket.frame(JSON.stringify({ id: 's1', from: 'postmaster@example', to: 'device@example', state: 'established' }));
  const session = await established;
  assert.equal(session.state, 'established');
  assert.equal(client.localNode, 'device@example');
  assert.equal(socket.sent.length, 1);
  const messages = [];
  client.onMessage = m => messages.push(m);
  socket.frame(JSON.stringify({ id: 'e1', type: 'application/json', content: { seq: 1 } }));
  assert.equal(messages[0].content.seq, 1);
  assert.deepEqual(JSON.parse(socket.sent[1]), { id: 'e1', to: 'postmaster@example', event: 'received' });
  client.dispose();
});
