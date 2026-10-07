export const type = "opencode_remote";
export const label = "opencode (remote server)";

export const models: Array<{ id: string; label: string }> = [];

export const agentConfigurationDoc = `# opencode_remote configuration

Use when: the agent should run on an existing \`opencode serve\` instance on another machine (a dev container), reachable over HTTP(S) from the Paperclip server.
Don't use when: opencode should run inside the Paperclip pod (use opencode_local).

Fields:
- baseUrl (required): https URL of the server, e.g. https://opencode-ct1.example.net (remote plain http is refused unless dangerouslyAllowInsecureRemoteHttp is true)
- serverPassword (required, secret): the server's OPENCODE_SERVER_PASSWORD
- username: basic-auth user, default "opencode"
- model: optional provider/model, e.g. opencode/big-pickle
- agent: optional opencode agent name
- directory: optional working directory on the remote host for new sessions
- timeoutSec: optional wall-clock limit, default none
- allowPrivateNetwork: permit loopback, private and link-local targets (default false; an SSRF guard refuses them otherwise)
- autoApprove: approve tool permission requests automatically (default false: the run fails instead)
- sendRunToken: include the run-scoped Paperclip API token in the prompt (default true)
- paperclipApiUrl: Paperclip base URL the remote agent should call
- promptTemplate: optional prompt with {{runId}} {{agentId}} {{agentName}} {{companyId}} {{apiUrl}} {{context}}
`;

export { createServerAdapter } from "./server/index.js";
