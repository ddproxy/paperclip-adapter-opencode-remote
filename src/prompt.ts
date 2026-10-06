import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { joinPromptSections, renderPaperclipWakePrompt } from "@paperclipai/adapter-utils/server-utils";
import type { RemoteConfig } from "./config.js";

const MAX_CONTEXT_CHARS = 20_000;

export interface PromptOptions {
  resumed: boolean;
  instructions?: string | null;
}

export function buildPrompt(ctx: AdapterExecutionContext, cfg: RemoteConfig, opts: PromptOptions): string {
  const context = (ctx.context ?? {}) as Record<string, unknown>;

  if (cfg.promptTemplate) {
    const contextJson = JSON.stringify(context, null, 2);
    const truncated =
      contextJson.length > MAX_CONTEXT_CHARS ? `${contextJson.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)` : contextJson;
    return joinPromptSections([
      opts.instructions,
      cfg.promptTemplate
        .replaceAll("{{runId}}", ctx.runId)
        .replaceAll("{{agentId}}", ctx.agent.id)
        .replaceAll("{{agentName}}", ctx.agent.name)
        .replaceAll("{{companyId}}", ctx.agent.companyId)
        .replaceAll("{{apiUrl}}", cfg.paperclipApiUrl)
        .replaceAll("{{context}}", truncated),
    ]);
  }

  const wakePrompt = renderPaperclipWakePrompt(context.paperclipWake, { resumedSession: opts.resumed });
  const handoff = typeof context.paperclipSessionHandoffMarkdown === "string" ? context.paperclipSessionHandoffMarkdown.trim() : "";

  const identity = [
    `You are ${ctx.agent.name}, an agent in a Paperclip company. This is one heartbeat run: do the assigned work, report through the Paperclip API, then stop.`,
    "",
    `Paperclip API: ${cfg.paperclipApiUrl || "(not configured)"}`,
    `Agent id: ${ctx.agent.id}`,
    `Company id: ${ctx.agent.companyId}`,
    `Run id: ${ctx.runId}`,
    "Send the header `X-Paperclip-Run-Id: <run id>` on every request that modifies an issue.",
  ].join("\n");

  const credentials: string[] = [];
  if (cfg.sendRunToken && ctx.authToken) {
    credentials.push(
      "Run-scoped API token (secret, valid for this run only; send as `Authorization: Bearer <token>`, never print or store it):",
      ctx.authToken,
    );
  }
  const tools = ctx.runtimeTools;
  if (cfg.sendRunToken && tools) {
    credentials.push(
      "",
      "Paperclip runtime tools:",
      tools.guidance,
      `MCP endpoint: ${tools.mcpEndpoint}`,
      `Tools token (secret, expires ${tools.expiresAt}): ${tools.bearerToken}`,
    );
  }

  const fallbackContext =
    wakePrompt.length === 0
      ? `Wake context (JSON):\n${(() => {
          const json = JSON.stringify(context, null, 2);
          return json.length > MAX_CONTEXT_CHARS ? `${json.slice(0, MAX_CONTEXT_CHARS)}\n... (truncated)` : json;
        })()}`
      : "";

  return joinPromptSections([opts.instructions, identity, credentials.join("\n"), wakePrompt, handoff, fallbackContext]);
}
