# Backlog

## LIME2-01 — Implement the LIME 2 v0.1 draft client

- Status: Completed
- Source: `fast-chat/docs/specifications/lime-2-v0.1-draft.md`, 2026-10-07 snapshot.
- Outcome: Default LIME 2 client with optional best-effort LIME 1 wire mode;
  native promises, bounded work, and measured client performance.
- Acceptance: versioned short establishment and fallback authentication;
  complete/streamed messages with exact revisions, text and RFC 7396 assembly;
  built-in aliases; valid notification scopes and safe cumulative receipt gaps;
  bounded retries and session cleanup; deterministic protocol contracts;
  browser/CommonJS/ESM and TypeScript package verification; at least 90% changed
  source coverage; reproducible benchmarks against the original client.
- Scope: client library only. Server authentication, persistence, UI rendering,
  history/replay resources, and HTTP attachment transfer remain application and
  transport responsibilities.
- Authority: explicit implementation request and permission to modernize the
  library. Fast-chat product milestones and ADRs are not changed by this task.
- Evidence: `npm run verify` passes 51 tests, generated public types, 99.08%
  total / 98.57% changed source coverage; package dry run and whitespace checks
  pass. Node 20 runtime smoke checks and 20 contract/package tests pass.
  Reproducible baseline comparison is recorded in `docs/lime-2-client.md`
  and `docs/benchmark-results.json`.

## LIME2-02 — Standardize alias registration and capability negotiation

- Status: Blocked on draft grammar
- Outcome: interoperable session alias-registration commands and optional
  streaming-capability exchange.
- Acceptance: selected command URI, payload, authority, conflict and size rules;
  selected capability fields, values, receive/send direction and omission rules;
  cross-implementation command and negotiation contract fixtures.
- Until then: expose a local alias registry for application-defined acknowledged
  commands; use documented streaming conventions; emit no invented wire fields.

## LIME2-03 — Adopt RFC 6902 structured streaming

- Status: Completed
- Authority: user selection, 2026-10-08; supersedes RFC 7396 for streamed JSON.
- Outcome: fresh revision assembly using JSON Patch with incremental array operations and literal null values.
- Acceptance: all six RFC operations, strict pointers/indices, atomic stream rejection, bounded operations/content/depth/copy work, ownership isolation, whole-message retry contracts, at least 90% changed-line coverage, and measured array streaming.
- Scope: JSON message assembly; complete JSON and LIME 1 mode retain their semantics. Streamed commands remain outside the current JS runtime.
- Evidence: 54 tests pass, 99.09% total lines / 99.41% changed lines (169/170), package dry run and array benchmarks pass. Shared vectors match Go and the live browser engine.
