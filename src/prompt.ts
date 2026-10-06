import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import type { RemoteConfig } from "./config.js";

const MAX_CONTEXT_CHARS = 20_000;

export function buildPrompt(ctx: AdapterExecutionContext, cfg: RemoteConfig): string {
  const contextJson = JSON.stringify(ctx.context ?? {}, null, 2);
  const truncated =
    contextJson.length > MAX_CONTEXT_CHARS ? `${contextJson.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)` : contextJson;

  if (cfg.promptTemplate) {
    return cfg.promptTemplate
      .replaceAll("{{runId}}", ctx.runId)
      .replaceAll("{{agentId}}", ctx.agent.id)
      .replaceAll("{{agentName}}", ctx.agent.name)
      .replaceAll("{{companyId}}", ctx.agent.companyId)
      .replaceAll("{{apiUrl}}", cfg.paperclipApiUrl)
      .replaceAll("{{context}}", truncated);
  }

  const lines = [
    `You are ${ctx.agent.name}, an agent in a Paperclip company. This is one heartbeat run: do the assigned work, report through the Paperclip API, then stop.`,
    "",
    `Paperclip API: ${cfg.paperclipApiUrl || "(not configured)"}`,
    `Agent id: ${ctx.agent.id}`,
    `Company id: ${ctx.agent.companyId}`,
    `Run id: ${ctx.runId}`,
    "Send the header `X-Paperclip-Run-Id: <run id>` on every request that modifies an issue.",
  ];
  if (cfg.sendRunToken && ctx.authToken) {
    lines.push(
      "",
      "Run-scoped API token (secret, valid for this run only; send as `Authorization: Bearer <token>`, never print or store it):",
      ctx.authToken,
    );
  }
  lines.push("", "Wake context (JSON):", truncated);
  return lines.join("\n");
}
