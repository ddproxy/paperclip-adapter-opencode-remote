import type { AdapterConfigSchema } from "@paperclipai/adapter-utils";

export function getConfigSchema(): AdapterConfigSchema {
  return {
    fields: [
      {
        key: "baseUrl",
        label: "opencode server URL",
        type: "text",
        required: true,
        hint: "HTTPS URL of `opencode serve` on the remote host, reachable from the Paperclip server.",
      },
      {
        key: "serverPassword",
        label: "Server password",
        type: "text",
        required: true,
        hint: "The server's OPENCODE_SERVER_PASSWORD. Stored as a Paperclip secret reference.",
        meta: { secret: true },
      },
      { key: "username", label: "Username", type: "text", default: "opencode" },
      {
        key: "model",
        label: "Model",
        type: "text",
        hint: "Optional provider/model, e.g. opencode/big-pickle. Empty uses the server default.",
      },
      { key: "agent", label: "opencode agent", type: "text", hint: "Optional opencode agent name." },
      {
        key: "directory",
        label: "Remote working directory",
        type: "text",
        hint: "Optional directory on the remote host for new sessions.",
      },
      {
        key: "paperclipApiUrl",
        label: "Paperclip API URL",
        type: "text",
        hint: "Base URL the remote agent should use to call Paperclip.",
      },
      { key: "timeoutSec", label: "Timeout (seconds)", type: "number", default: 0, hint: "0 means no limit." },
      {
        key: "autoApprove",
        label: "Auto-approve tool permissions",
        type: "toggle",
        default: false,
        hint: "Off: a run that needs a permission fails instead of acting.",
      },
      {
        key: "sendRunToken",
        label: "Send run token in prompt",
        type: "toggle",
        default: true,
        hint: "The remote agent needs it to call Paperclip; it is short-lived but stays in that session's history.",
      },
      {
        key: "dangerouslyAllowInsecureRemoteHttp",
        label: "Dangerously allow remote HTTP",
        type: "toggle",
        default: false,
        hint: "Unsafe dev-only escape hatch. Loopback HTTP is always allowed.",
      },
    ],
  };
}
