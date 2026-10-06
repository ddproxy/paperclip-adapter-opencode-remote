# End-to-end test plan

Prerequisites: a reachable opencode server (CT or local) with a known password, a model with free quota, the plugin installed in Paperclip (`POST /api/adapters/install`), one agent using adapter `opencode_remote`.

| # | Test | Setup | Action | Expected |
|---|---|---|---|---|
| 1 | Install | Plugin built | Install via the adapters API; open the adapter list | `opencode_remote` listed; config doc shown |
| 2 | Environment test | Valid config | Run the agent's environment test | pass, server version shown |
| 3 | Bad credentials | Wrong password | Environment test | fail, `opencode_remote_auth_failed` |
| 4 | Unreachable | Wrong host | Environment test and a run | fail / run errors with `unreachable` |
| 5 | Successful run | Assign a small issue ("print the date to a file") | Wake the agent | Live text and `[tool]` lines in the run log; run succeeds; usage and cost recorded; summary present |
| 6 | Session resume | Same agent | Wake it again | Log says "resumed session"; the same session id; context from run 1 retained |
| 7 | Cancel | Long task | Cancel from the UI mid-run | Run ends as cancelled within ~5 s; remote session idle (check `GET /api/session/active`) |
| 8 | Timeout | `timeoutSec: 30`, long task | Wake | Run ends `timeout`; remote turn interrupted |
| 9 | Rate limit | Exhausted model quota | Wake | Run fails with `rate_limited` and the provider message |
| 10 | Server restart mid-run | Long task | Restart `opencode-serve` during the run | Run fails with `stream_closed` or `unreachable`; next run creates or resumes a session cleanly |
| 11 | Permission | Task needing a gated tool, `autoApprove: false` | Wake | Run fails `permission_required`; no action taken |
| 12 | Auto approve | Same, `autoApprove: true` | Wake | Permission replied `once`; run completes |
| 13 | Pause/resume agent | Pause the agent | Assign an issue | No remote session created |

For each: check the Paperclip run log, the run's final status, and `aoe`/opencode state on the CT. Record the real event sequence from test 5; if it differs from `NOTES.md`, fix `handle()` first.
