# lime-js

LIME conversation client for JavaScript and TypeScript. This implementation
supports the **LIME 2 v0.1 review draft (2026-10-07)**, with an explicit best-effort
LIME 1 wire mode. The draft is not an official released LIME standard.

The client uses native promises and has no runtime dependencies. Builds include
CommonJS (`dist/lime.js`), ESM (`dist/lime.mjs`), and browser/AMD UMD bundles
(`dist/lime.js`, `dist/lime.min.js`). Type declarations ship with the package.
Runtime: Node 18+ or a modern browser; development and tests: Node 24+.

## Use

Supply an opened transport that implements the exported `Transport` interface.
The transport delivers parsed envelopes through `onEnvelope` and implements
`send`, `close`, compression and encryption accessors. A WebSocket transport
must send one JSON envelope per text frame and preserve frame order.

```js
import { ClientChannel, PlainAuthentication } from 'lime-js';

const client = new ClientChannel(transport);
client.onMessage = message => renderCompleteMessage(message);
client.onMessageProgress = frame => showProgress(frame); // raw start/data/end
client.onNotification = notification => updateReadStatus(notification);
client.onProtocolError = (error, envelope) => handleProtocolFailure(error);
client.onDeliveryError = (error, message) => showDeliveryFailure(message, error);

// One request/response when HTTP transport authentication already succeeded.
await client.establishSession();

client.sendMessage({ type: 'text', content: 'Hello!' }); // ID-less fire-and-forget
client.sendMessage({ id: 'm1', thread: 't1', type: 'text', content: 'Tracked delivery' });
```

When the server requires LIME authentication, pass the credentials explicitly:

```js
await client.establishSession(undefined, undefined,
  'alice@example.org', new PlainAuthentication(password), 'browser');
```

The server authenticates and authorizes the session. The client never assumes
that an absent authentication challenge implies anonymous authorization. Version
2 sends `{state:'new', version:2}` and never silently downgrades.

## Streaming and revisions

```js
client.sendMessage({ id: 'm2', rev: 2, thread: 't1', type: 'text', stream: 'start' });
client.sendMessage({ id: 'm2', rev: 2, stream: 'data', content: 'Hello ' });
client.sendMessage({ id: 'm2', rev: 2, stream: 'data', content: 'again!' });
client.sendMessage({ id: 'm2', rev: 2, stream: 'end' });
```

Revision omission means `1` on **every** frame. Revisions must be positive safe
integers. Start has a type and no content; data has content and no type; end has
neither. Sending end asserts successful persisted completion: callers must not
use it merely because generation or the transport stopped.

Text contributions concatenate. JSON streams start at `{}` and apply
[RFC 7396 JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7396.html): object
members merge, null members delete, arrays/scalars replace. JSON-looking text
is never automatically parsed a second time.

`onMessage` receives only complete messages, with canonical MIME types.
`onMessageProgress` receives raw stream frames without repeatedly copying the
assembled text. Renderers own schema validation and progressive presentation.
A synchronous `onMessage` exception prevents automatic receipt. For asynchronous
validation or application-specific receipt control, disable automatic receipts
with the third constructor argument and send notifications explicitly.

Built-in aliases: `text`, `json`, `chatstate`, `collection`, `document-select`,
`location`, `media-link`, `select`, `web-link`. A local `ContentTypeRegistry`
supports session aliases; call `client.contentTypes.register(alias, canonical)`
only after an application-defined registration command is acknowledged. The
review draft has not selected that command's wire grammar.

## Delivery and commands

LIME 2 defaults to individual automatic `received` notifications after complete
content. No receipt-configuration or presence command is sent.

```js
client.sendNotification({ id: 'm1', event: 'consumed', thread: 't1' });
client.sendNotification({ id: 'm1', event: 'consumed', scope: 'thread', thread: 't1' });
const response = await client.processCommand({ id: 'c1', method: 'get', uri: '/example' });
if (response.status === 'failure') handleCommandFailure(response.reason);
```

Omitted scope is `message`. `received` allows `message`/`session`; `consumed`
allows `message`/`thread`; `failed` allows only `message` and requires a LIME
reason. A session receipt cannot cross an unfinished earlier message.
Consumed/failed notifications never clear the receipt buffer. Read ordering and
correct emission of thread watermarks remain application responsibilities.

Tracked deliveries retry automatically, bounded by the options below. Retries
send the full completed message with the original `(id, rev)`. This is
**at-least-once delivery**: applications must deduplicate before consequential
side effects. ID-less messages are neither buffered nor retried. Buffer
exhaustion throws before send; retry exhaustion reports `onDeliveryError` and
keeps the message unacknowledged. Transport errors throw and remove that send's
local pending state; callers must recover explicitly.

```js
const client = new ClientChannel(transport, true, undefined, {
  version: 2,
  maxStreams: 64,
  maxContentBytes: 1048576,
  maxJsonDepth: 64,
  maxPendingMessages: 256,
  maxPendingCommands: 256,
  retryInterval: 5000,   // 0 disables automatic scheduling
  maxRetryAttempts: 3,
  sessionTimeout: 10000 // per establishment/negotiation/authentication/close exchange
});
```

Limits are client policy, not standardized protocol values. Content bytes bound
both individual JSON-encoded values and cumulative stream contributions,
including encoding overhead; even empty contributions consume capacity. Framing,
metadata sizes, origin checks and transport backpressure belong to the transport.
By default protocol errors throw; install `onProtocolError` for controlled
recovery. Invalid streams are abandoned and cannot produce successful receipts.

`processCommand` resolves command responses, including failure status; it rejects
on timeout, transport failure or session termination. Correlation uses exact
request IDs and expected peers. `commandTimeout` defaults to 6,000 ms. Successful
responses cancel their timers. Timeouts never include resource/credential data.

Call `await client.sendFinishingSession()` for protocol closure, or
`client.dispose()` to release local timers, waiters and the transport listener.
Disposal does not close a transport owned by the caller. A new connection uses a
new channel/session; no stream, alias registry or pending buffer resumes. Session
termination/disposal reports outstanding deliveries via `onDeliveryError` before
dropping this session's in-memory state. Persist/requeue them at the application
boundary if required.

## Best-effort LIME 1

```js
const legacy = new ClientChannel(transport, true, false, { version: 1 });
```

This mode sends the unversioned new-session envelope, retains legacy
notifications, and passes ordinary MIME messages through without LIME 2 assembly
or retry tracking. Streaming is rejected. It uses the same native-promise API;
Bluebird-specific methods and the old hand-written declarations are not retained.
Compatibility is covered by local contracts, not certified against live legacy
servers. `Guid()` uses Web Crypto and requires it when called.

## Develop and verify

```sh
npm ci
npm run verify
npm run benchmark
```

Verification builds every format, checks protocol/serialized transport contracts,
public TypeScript types, and at least 90% total and changed source line coverage.
For committed changes set `DIFF_COVERAGE_BASE` to the comparison commit; the local
default is `HEAD` (working-tree changes). CI compares `HEAD^` and also enforces
full-source coverage. `npm run watch` rebuilds bundles; run `npm run build` to
refresh declarations after type changes.

Compare with an original built checkout:

```sh
LIME_BASELINE_BUNDLE=/path/to/original/dist/lime.js npm run benchmark
```

See [implementation choices and measured evidence](docs/lime-2-client.md),
[benchmark data](docs/benchmark-results.json), and [backlog](BACKLOG.md).
