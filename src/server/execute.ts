import type { AdapterExecutionContext, AdapterExecutionResult } from "@paperclipai/adapter-utils";
import {
  HttpOpencodeClient,
  OpencodeHttpError,
  OpencodeUnreachableError,
  type OpencodeClient,
  type OpencodeEvent,
} from "../client.js";
import { ConfigError, parseConfig, type RemoteConfig } from "../config.js";
import { NetworkGuardError } from "../net-guard.js";
import { buildPrompt } from "../prompt.js";
import { readInstructionsFile } from "./instructions.js";

export type ClientFactory = (cfg: RemoteConfig) => OpencodeClient;

export const defaultClientFactory: ClientFactory = (cfg) =>
  new HttpOpencodeClient({
    baseUrl: cfg.baseUrl,
    username: cfg.username,
    password: cfg.serverPassword,
    allowPrivateNetwork: cfg.allowPrivateNetwork,
  });

const CANCEL_SETTLE_MS = 5_000;

function familyFor(code: string, message: string): AdapterExecutionResult["errorFamily"] {
  if (code === "rate_limited") {
    return /usage exceeded|quota|subscribe/i.test(message) ? "provider_quota" : "transient_upstream";
  }
  if (code === "unreachable" || code === "stream_closed" || code === "stream_error") return "transient_upstream";
  if (code === "remote_http_error" && /HTTP 5\d\d/.test(message)) return "transient_upstream";
  return null;
}

function failure(errorCode: string, errorMessage: string, extra: Partial<AdapterExecutionResult> = {}): AdapterExecutionResult {
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    errorCode,
    errorMessage,
    errorFamily: familyFor(errorCode, errorMessage),
    ...extra,
  };
}

function classifyError(err: unknown): AdapterExecutionResult {
  if (err instanceof ConfigError) return failure("invalid_config", err.message);
  if (err instanceof NetworkGuardError) return failure("blocked_network", `${err.message}. Set allowPrivateNetwork to permit private targets.`);
  if (err instanceof OpencodeUnreachableError) return failure("unreachable", err.message);
  if (err instanceof OpencodeHttpError) {
    if (err.status === 401) return failure("auth_failed", "opencode server rejected the credentials (401)");
    return failure("remote_http_error", err.message);
  }
  return failure("adapter_error", err instanceof Error ? err.message : String(err));
}

function looksRateLimited(message: string): boolean {
  return /rate.?limit|usage exceeded|quota|too many requests|429/i.test(message);
}

const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const text = (v: unknown): string => (typeof v === "string" ? v : "");

export async function executeWithClient(
  ctx: AdapterExecutionContext,
  makeClient: ClientFactory = defaultClientFactory,
): Promise<AdapterExecutionResult> {
  let cfg: RemoteConfig;
  try {
    cfg = parseConfig(ctx.config);
  } catch (err) {
    return classifyError(err);
  }
  const client = makeClient(cfg);
  const log = (stream: "stdout" | "stderr", chunk: string) => ctx.onLog(stream, chunk);

  let sessionId: string;
  let resumed = false;
  try {
    const prior = ctx.runtime.sessionParams;
    const priorId = typeof prior?.sessionId === "string" ? prior.sessionId : null;
    if (priorId && prior?.baseUrl === cfg.baseUrl && (await client.sessionExists(priorId))) {
      sessionId = priorId;
      resumed = true;
    } else {
      sessionId = (
        await client.createSession({
          agent: cfg.agent ?? undefined,
          model: cfg.model ?? undefined,
          directory: cfg.directory ?? undefined,
        })
      ).id;
    }
  } catch (err) {
    return classifyError(err);
  }
  await log("stdout", `[opencode_remote] ${resumed ? "resumed" : "created"} session ${sessionId} on ${cfg.baseUrl}\n`);

  let instructions: string | null = null;
  if (cfg.instructionsFilePath) {
    try {
      const contents = (await readInstructionsFile(cfg.instructionsFilePath)).trim();
      if (contents) {
        instructions = `${contents}\n\nThe above agent instructions were loaded from ${cfg.instructionsFilePath} on the Paperclip host; files they reference are not available on this machine.`;
        await log("stdout", `[opencode_remote] loaded agent instructions from ${cfg.instructionsFilePath}\n`);
      }
    } catch (err) {
      await log(
        "stderr",
        `[opencode_remote] could not read instructions file "${cfg.instructionsFilePath}": ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
  const promptText = buildPrompt(ctx, cfg, { resumed, instructions });
  await ctx.onMeta?.({
    adapterType: "opencode_remote",
    command: cfg.baseUrl,
    commandNotes: [`${resumed ? "Resumed" : "Created"} remote session ${sessionId}`],
    prompt: promptText,
    promptMetrics: { promptChars: promptText.length, instructionsChars: instructions?.length ?? 0 },
    context: ctx.context,
  });

  const streamAbort = new AbortController();
  let events: AsyncIterable<OpencodeEvent>;
  try {
    events = await client.subscribe(streamAbort.signal);
  } catch (err) {
    return classifyError(err);
  }

  const state = {
    sawActivity: false,
    finished: false,
    cancelled: false,
    timedOut: false,
    failure: null as { code: string; message: string } | null,
    lastText: "",
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    costUsd: 0,
    sawUsage: false,
  };
  let settle!: () => void;
  const finishedPromise = new Promise<void>((resolve) => (settle = resolve));
  const finish = () => {
    if (!state.finished) {
      state.finished = true;
      settle();
    }
  };
  const fail = (code: string, message: string) => {
    state.failure ??= { code, message };
    finish();
  };

  const handle = async (ev: OpencodeEvent) => {
    const d = ev.data;
    if (d.sessionID !== undefined && d.sessionID !== sessionId) return;
    switch (ev.type) {
      case "session.next.step.started":
        state.sawActivity = true;
        break;
      case "session.next.text.delta":
        state.sawActivity = true;
        await log("stdout", text(d.delta));
        break;
      case "session.next.text.ended":
        state.sawActivity = true;
        state.lastText = text(d.text) || state.lastText;
        await log("stdout", "\n");
        break;
      case "session.next.tool.called": {
        state.sawActivity = true;
        const input = JSON.stringify(d.input ?? {});
        await log("stdout", `[tool] ${text(d.tool)} ${input.length > 400 ? `${input.slice(0, 400)}...` : input}\n`);
        break;
      }
      case "session.next.tool.failed":
        await log("stderr", `[tool failed] ${JSON.stringify(d.error ?? {}).slice(0, 400)}\n`);
        break;
      case "session.next.step.ended": {
        state.sawActivity = true;
        const tokens = (d.tokens ?? {}) as Record<string, unknown>;
        const cache = (tokens.cache ?? {}) as Record<string, unknown>;
        state.inputTokens += num(tokens.input);
        state.outputTokens += num(tokens.output) + num(tokens.reasoning);
        state.cachedInputTokens += num(cache.read);
        state.costUsd += num(d.cost);
        state.sawUsage = true;
        break;
      }
      case "session.status": {
        const status = (d.status ?? {}) as Record<string, unknown>;
        if (status.type === "busy" || status.type === "retry") state.sawActivity = true;
        if (status.type === "idle" && state.sawActivity) finish();
        break;
      }
      case "session.idle":
        if (state.sawActivity) finish();
        break;
      case "session.error": {
        const message = text((d.error as Record<string, unknown> | undefined)?.message) || text(d.message) || "session error";
        fail(looksRateLimited(message) ? "rate_limited" : "remote_session_error", message);
        break;
      }
      case "permission.v2.asked": {
        const id = text(d.id);
        if (cfg.autoApprove && id) {
          await log("stdout", `[permission] auto-approved ${text(d.action)}\n`);
          await client.replyPermission(sessionId, id, "once");
        } else {
          await log("stderr", `[permission] blocked on ${text(d.action)}; autoApprove is off\n`);
          if (id) await client.replyPermission(sessionId, id, "reject").catch(() => undefined);
          fail("permission_required", `Agent requested permission for ${text(d.action) || "an action"} and autoApprove is off`);
          await client.interrupt(sessionId).catch(() => undefined);
        }
        break;
      }
      case "question.v2.asked": {
        const id = text(d.id);
        await log("stderr", "[question] agent asked a question; rejecting so the run can continue\n");
        if (id) await client.rejectQuestion(sessionId, id).catch(() => undefined);
        break;
      }
      default:
        break;
    }
  };

  const consume = (async () => {
    try {
      for await (const ev of events) {
        await handle(ev);
        if (state.finished) break;
      }
      if (!state.finished) fail("stream_closed", "opencode event stream closed before the run finished");
    } catch (err) {
      if (!streamAbort.signal.aborted) {
        fail(err instanceof OpencodeUnreachableError ? "unreachable" : "stream_error", err instanceof Error ? err.message : String(err));
      }
    }
  })();

  const stop = async (reason: "cancelled" | "timeout") => {
    if (state.finished) return;
    if (reason === "cancelled") state.cancelled = true;
    else state.timedOut = true;
    await client.interrupt(sessionId).catch(() => undefined);
    await Promise.race([finishedPromise, new Promise((r) => setTimeout(r, CANCEL_SETTLE_MS))]);
    finish();
  };

  const onAbort = () => void stop("cancelled");
  ctx.signal?.addEventListener("abort", onAbort, { once: true });
  const timer = cfg.timeoutSec > 0 ? setTimeout(() => void stop("timeout"), cfg.timeoutSec * 1000) : null;

  try {
    ctx.onDispatch?.();
    await ctx.onCancellationReady?.();
    if (ctx.signal?.aborted) {
      await stop("cancelled");
    } else {
      try {
        await client.prompt(sessionId, promptText);
      } catch (err) {
        streamAbort.abort();
        await consume;
        return classifyError(err);
      }
      await finishedPromise;
    }
  } finally {
    if (timer) clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onAbort);
    streamAbort.abort();
    await consume;
  }

  const base: AdapterExecutionResult = {
    exitCode: 0,
    signal: null,
    timedOut: false,
    sessionParams: { sessionId, baseUrl: cfg.baseUrl },
    sessionDisplayId: sessionId,
    provider: cfg.model?.providerID ?? null,
    model: cfg.model ? `${cfg.model.providerID}/${cfg.model.id}` : null,
    summary: state.lastText || null,
    ...(state.sawUsage
      ? {
          usage: {
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            cachedInputTokens: state.cachedInputTokens,
          },
          usageBasis: "per_run" as const,
          costUsd: state.costUsd,
        }
      : {}),
  };

  if (state.cancelled) {
    return { ...base, exitCode: null, signal: "SIGTERM", errorCode: "cancelled", errorMessage: "Run cancelled" };
  }
  if (state.timedOut) {
    return {
      ...base,
      exitCode: null,
      timedOut: true,
      errorCode: "timeout",
      errorMessage: `Run exceeded timeoutSec (${cfg.timeoutSec}s)`,
    };
  }
  if (state.failure) {
    return {
      ...base,
      exitCode: 1,
      errorCode: state.failure.code,
      errorMessage: state.failure.message,
      errorFamily: familyFor(state.failure.code, state.failure.message),
    };
  }
  return base;
}

export const execute = (ctx: AdapterExecutionContext) => executeWithClient(ctx);
