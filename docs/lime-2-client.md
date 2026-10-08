# LIME 2 v0.1 client implementation

Implemented task: LIME2-01. Source: the supplied
`fast-chat/docs/specifications/lime-2-v0.1-draft.md`, dated 2026-10-07.
Source SHA-256:
`366951a4fc9607ead4d9bc497a4a5544d724206c26f323b2c023ebb4056f4294`.
This implements selected draft rules and documents local policy; it does not
freeze the draft or certify independent-server interoperability.

## Contract coverage

| Draft section | Client behavior |
| --- | --- |
| 2: sessions | Explicit version 2; direct establishment, optional transport negotiation and fallback LIME authentication; server-issued IDs; bounded exchanges; terminal state cannot reopen; no automatic downgrade/resume. |
| 3–4: messages | Optional IDs on complete messages; positive safe-integer revisions default to 1 independently on every envelope; thread context; start/data/end; no native multipart. |
| 4.1: text | Decoded contributions are accumulated and joined only at terminal completion; raw progress callbacks avoid repeated full snapshots. |
| 4.2: JSON | Fresh empty object per stream/revision; RFC 7396 merge/delete/replace; scalar and array replacements; prototype-shaped keys treated as JSON data. |
| 5: notifications | Received/consumed/failed event and scope validation; exact revision and peer correlation; individual and cumulative session receipts; incomplete-prefix rejection; no read/failure clearing of transport buffers. |
| 5.1: retries | Bounded in-memory logical-message buffer; same-ID/revision complete replay; bounded automatic attempts; explicit retry API; exhaustion remains unacknowledged. |
| 6: aliases | All nine enumerated built-ins; canonical MIME resolution; no second parsing or rewriting of nested MIME fields; local additive session registry. |
| 7: commands | Native promise request/response correlation, expected-peer checks, bounded pending requests, canceled timers, deterministic timeouts and terminal cleanup; legacy methods retained. |
| 7.1: profile limits | Text and JSON streaming convention; no capability-negotiation fields; bounded message bytes, depth, streams, commands, retries and exchange timing. |
| 7.2: discrimination | Own-field presence, including null/empty values and stream-only frames; competing families rejected in version 2; no extra kind field. |
| 8–9: boundaries | External transport, authentication/authorization, rendering, storage/history, attachments and provider adapters remain application responsibilities. |

## Explicit local policies

The draft leaves retry timing, pending lifetime and some error handling open.
This implementation excludes ID-less traffic from buffering and preserves
`(id, rev)` on retry. It rejects unresolved markers and cumulative gaps rather
than implicitly resolving a failed/incomplete prefix. A `failed` notification
reports failure but does not acknowledge delivery; a later full retry can resolve
the pending message through `received`. Buffer exhaustion throws before send.
Send failure removes that operation's pending state and reports the exception;
the caller owns recovery from possible partial transport execution.

Retry exhaustion reports an application callback and retains pending state.
A session end or disposal reports and drops its outstanding in-memory deliveries;
new sessions need a new channel and explicit application requeue. Received
marker history stores only thread/position markers, releases acknowledged content,
and is bounded to four times the pending capacity. Duplicate/older
markers within that window are harmless and cannot acknowledge later deliveries;
unknown or evicted markers fail locally. Edited UI position and thread-wide read
prefix selection remain application contracts. The receiver intentionally permits
at-least-once complete replay: deduplicate side effects at the application boundary.

A full replay can replace an interrupted assembly only after validating its
complete content. Partial content without end never triggers `onMessage` or a
successful receipt. A malformed contribution abandons its assembly. Unsupported
or malformed frames surface through `onProtocolError`; the default throws.
No speculative wire failure reason or automatic session downgrade is introduced.
Applications can send an agreed LIME failure notification when appropriate.

The library consumes already-parsed envelopes. Duplicate raw JSON keys cannot be
detected after parsing; framing/parser strictness, maximum metadata/frame size,
transport authentication and backpressure belong to the transport. It accepts
canonical MIME names for complete content, while unknown aliases and non-text/
non-JSON streaming types fail. Alias recognition supplies no renderer, schema,
capability or action authorization. Renderers validate their content schemas.

The optional negotiating state retains transport compression/encryption exchange.
Alias-registration URI/payload/authority and streaming-capability grammar are still
unselected. LIME2-02 records their acceptance criteria; no invented wire contract
is emitted. A local alias registration API can support an application-defined,
acknowledged command, but is not claimed as standardized command interoperability.

## Modernization and compatibility

Removed Bluebird, webpack 4, UglifyJS, outdated release/commit tooling and stale
hand-written types. Native promises, ES2018 output, generated declarations, ESM
and UMD/CommonJS builds now share the same source. No runtime dependencies.
Command maps are safe for IDs such as `__proto__`; responses cancel their timers.
UUID generation uses Web Crypto without a bundled crypto shim.

Version 2 is the default. Optional version 1 emits the original unversioned new
session, retains ordinary message pass-through and legacy notification events,
and skips LIME 2 assembly/retry tracking. There is no promise of old Bluebird
extensions or source API compatibility. LIME 1 support is best effort and tested
with deterministic local contracts, without a live historical server.

## Verification and measured performance

`npm run verify` passes 48 deterministic tests: selected wire semantics, RFC 7396
appendix fixtures, independent UTF-8 byte-count bounds, malformed/rejected input,
peer and revision isolation, cumulative gaps, bounded timer-controlled retries,
command cleanup, delayed terminal establishment, and serialized bidirectional
transport contracts (including lost end frames and lost receipts). Package checks
cover native ESM/CommonJS imports, UMD browser/AMD execution in VM contexts, and a
strict TypeScript consumer. `npm pack --dry-run` checks shipped bundles and types.

Final verification: 99.06% total source line coverage and 98.53% changed source
line coverage (602/611 measured changed lines). CI enforces at least 90% total
and changed source line coverage. Declaration-only
TypeScript emits no executable code and is excluded naturally; missing coverage
for changed executable source fails closed. Benchmark results below are local
synthetic medians, one warmup and seven samples on v24.15.0, darwin/
arm64. Baseline is original commit `5a96936`, built with its original
webpack toolchain; its Node load needs a `window` shim. No simulated network delay
is included. Benchmark instrumentation counts and clears leftover baseline timers
between rounds; it does not change the library's command resolution behavior.

| Measurement | Original | New client |
| --- | ---: | ---: |
| Minified bytes | 96,945 | 23,223 |
| Gzip bytes, level 9 | 27,035 | 7,463 |
| 5,000 in-memory command round trips | 30.18 ms | 1.94 ms |
| Timers still alive after those responses | 5,000 | 0 |
| 100,000 complete-message receives | 0.59 ms | 10.78 ms, strict LIME 2 |
| 100,000 legacy pass-through receives | 0.59 ms | 0.76 ms, LIME 1 mode |
| 10,000 text contributions / 320,000 characters | Unsupported | 2.62 ms |

The gzip bundle is 72.4% smaller. Command resolution is substantially
faster and no longer retains successful-request timers. LIME 2 validation,
byte limits, normalization and content ownership cost more CPU than the original
unvalidated receive path; the table retains that comparison. These measurements
are not production latency, mobile battery or real-network load claims. Full
benchmark data and reproduction instructions are in
[benchmark-results.json](benchmark-results.json) and the [README](../README.md).
