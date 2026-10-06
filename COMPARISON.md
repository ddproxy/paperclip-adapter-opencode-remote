# Comparison with Paperclip's built-in adapters

Compared against `opencode_local`, `claude_local`, `hermes_gateway`, `openclaw_gateway` and `cursor_cloud` (server `registry.ts`, each adapter's `execute.ts`, and `@paperclipai/adapter-utils` 2026.916.1). Remote-calling adapters (`hermes_gateway`, `openclaw_gateway`, `cursor_cloud`) are the closest peers.

## Gaps found and fixed
| Gap | Why it mattered | Fix |
|---|---|---|
| `supportsLocalAgentJwt` not set | The server mints the run token only when the adapter declares it, so `ctx.authToken` was always empty and the remote agent could not call Paperclip | Declared `true` |
| `runtimeToolDelivery` not set; `ctx.runtimeTools` ignored | Remote peers use `"invocation_context"`; the agent never learned about Paperclip's runtime tools | Declared `"invocation_context"`; tools guidance, endpoint and token go in the prompt (gated by `sendRunToken`) |
| Wake context dumped as raw JSON | Peers render it with `renderPaperclipWakePrompt` (comment batches, execution contract, recovery notes, resumed-session variant) and add the session handoff note | Uses `renderPaperclipWakePrompt` and `paperclipSessionHandoffMarkdown`; JSON dump only as a fallback |
| Agent instructions ignored | Peers read `instructionsFilePath` on the Paperclip host and prefix it to the prompt | `supportsInstructionsBundle`/`instructionsPathKey` declared; file contents prefixed, missing file is a logged warning |
| Plain http only warned about | `hermes_gateway` refuses remote plain http unless `dangerouslyAllowInsecureRemoteHttp` is set (loopback exempt) | Same rule; `parseConfig` throws, so runs and the environment test both fail |
| No `errorFamily` | Lets Paperclip tell quota exhaustion from transient upstream failure | `provider_quota` for usage/quota messages, `transient_upstream` for rate limits, unreachable, stream loss and 5xx |
| No `sessionCodec` | Peers validate stored session params and give the UI a display id | `{sessionId, baseUrl}` codec |
| No `onMeta` | Run details in the UI show the invocation and prompt | Reports command (base URL), notes, prompt, prompt metrics, context; no secrets |
| No config schema | The UI could not render a form; secrets could not be flagged | `getConfigSchema` with `serverPassword` marked `meta.secret` |

## Open (not done)
- **UI parser** (`ui-parser.ts`, `exports["./ui-parser"]`, `paperclip.adapterUiParser` in package.json). Without it the UI shows the log as plain assistant text; our `[tool]` lines are not rendered as tool cards.
- **Model list.** `listModels` / `detectModel` could read `GET /api/model` from the server so the UI offers a dropdown.
- **`sessionManagement`** (compaction and rotation policy). Sessions are reused indefinitely, so context grows until opencode compacts it.
- **Skills sync** (`listSkills`/`syncSkills`). Paperclip cannot install skills on the remote host; an agent's desired skills are not applied.
- **`Retry-After`.** `retryNotBefore` is not set from response headers.
- **Cost reporting.** `billingType` is not set; `onEvent`/`onRuntimeProgress` are not emitted.
- **Persistence boundary.** Paperclip's contract treats the local execution workspace as the only cross-run persistence. A remote run's file changes stay on the remote host; only the issue comments and logs come back. Anything that must reach Paperclip has to be reported through the API.
- **Workspace mapping.** `opencode_local` runs in the project workspace; here `directory` is a fixed path on the remote host.
- **Session handoff on fresh sessions.** `opencode_local` calls a hydration step before a fresh session; we only use the handoff markdown if it is already in the context.
