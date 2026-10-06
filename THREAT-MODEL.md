# Threat model: Paperclip calling a remote opencode server

Design: Paperclip (cluster pod) calls `opencode serve` on a dev container over HTTPS. The agent behind it runs shell commands as root on that container, with whatever credentials that container holds.

## Risks, highest first
1. **Endpoint exposure plus one shared password.** Anyone who reaches the endpoint and knows the password gets root-equivalent command execution on the CT. Required before first use: the endpoint must not be open to the internet. Put it behind a tunnel route with an Access service token (or equivalent) so a leaked password alone is not enough, and use a long random password per CT.
2. **Prompt injection into a root agent.** Issue titles, comments and descriptions flow into the prompt. A hostile issue can instruct the agent to exfiltrate files or run commands. Required: only assign the adapter to agents whose issues come from trusted authors; keep `autoApprove` off by default so tool use that needs permission fails the run; scope each CT's agent by instructions.
3. **Blast radius per CT.** The agent can read everything on the CT, including its pass store, forge tokens and the Paperclip agent key. Recommended: run the opencode server as a dedicated non-root user with a minimal home, and keep CT secrets out of that user's reach.
4. **Run token in the prompt.** The run-scoped Paperclip token is sent in the prompt (`sendRunToken`) and persists in session history on the CT. Mitigation: it is short-lived and run-scoped; set `sendRunToken: false` for agents that never call Paperclip back.
5. **Secrets in logs.** Streamed tool input and output go to Paperclip run logs. The adapter never logs the server password, but the agent could print a secret. Mitigation: treat run logs as sensitive; truncate tool input (done at 400 chars).
6. **Abort and DoS.** A stuck run holds the remote session. The adapter interrupts on cancel and timeout (`timeoutSec`), waits 5 s, then returns anyway; set a timeout for every agent. A flood of runs can exhaust the CT; rely on Paperclip concurrency limits per agent.
7. **Plain http.** Remote plain http is refused unless `dangerouslyAllowInsecureRemoteHttp` is set (loopback is always allowed), matching `hermes_gateway`. Leave the flag off outside local development.

## Required before first use
Items 1 and 7, and a decision on 3 for each CT. Items 2 and 4 are configuration choices, not code.

## Password rotation
Change `OPENCODE_SERVER_PASSWORD` on the CT, restart the service, update the agent's `serverPassword` in Paperclip's secret store. Existing sessions survive the restart only if the server persists them (unverified).
