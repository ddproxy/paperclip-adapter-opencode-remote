# Notes

## Status
`opencode_remote` adapter plugin: builds (`npm run build`) and passes its tests (`npm test`, 29 tests against an in-process mock server). See `COMPARISON.md` for how it lines up with Paperclip's built-in adapters. Not yet installed in Paperclip or run against a real remote server.

## Verified
- Against a live `opencode serve` 1.18.18 (local, throwaway, no model calls): `GET /global/health` returns `{healthy, version}`; HTTP basic auth with user `opencode` (bad password gives 401); `POST /api/session` and `GET /api/session/{id}` behave as in the spec; `GET /api/event` is SSE and the parser reads its frames; `POST .../interrupt` on an idle session succeeds.
- Types and lifecycle follow `@paperclipai/adapter-utils` 2026.916.1 (`signal`, `onDispatch`, `onCancellationReady`, `sessionParams`, `usage`).

## Not verified (needs a real model turn on a real server)
- Order and shape of events after `POST /api/session/{id}/prompt`: the adapter finishes on `session.idle` (or `session.status` idle) only after it has seen activity (`step.started`, text, tool, or busy status). If a real server emits a different sequence, fix `handle()` in `src/server/execute.ts`.
- `resume: true` on the prompt body actually starting the agent loop (`TODO(verify)` in `src/client.ts`).
- Event payload field names beyond the schema (`error.message` on `session.error`, `action` on `permission.v2.asked`).
- Behaviour on opencode 1.18.33 (CTs) versus 1.18.18 (spec).

## Deliberate choices
- `POST /api/session/{id}/wait` is not used; completion comes from the event stream, with the run timeout as the backstop.
- No `sessionCodec`; `sessionParams` is `{sessionId, baseUrl}` and a session recorded for a different `baseUrl` is not resumed.
- The run-scoped Paperclip token is placed in the prompt when `sendRunToken` is true (default), because a remote opencode has no other way to receive it. `supportsLocalAgentJwt` must stay true or the server never mints it. It is short-lived but ends up in that session's history on the remote host.
- Questions are rejected so the agent can continue; permissions fail the run unless `autoApprove` is true.
- Build/test scripts use `npm run`; `pnpm` here stops on esbuild's ignored install script (`strict-dep-builds`).
