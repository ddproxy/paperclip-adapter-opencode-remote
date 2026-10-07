import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executeWithClient } from "../src/server/execute.js";
import { testEnvironmentWithClient } from "../src/server/test.js";
import { createServerAdapter } from "../src/server/index.js";
import { happyScript, startMockServer, type MockServer } from "./mock-server.js";

let mock: MockServer;
beforeEach(async () => {
  mock = await startMockServer();
  mock.script = happyScript;
});
afterEach(async () => {
  await mock.close();
});

function makeCtx(overrides: Partial<AdapterExecutionContext> & { config?: Record<string, unknown> } = {}) {
  const logs: Array<[string, string]> = [];
  const { config, ...rest } = overrides;
  const ctx = {
    runId: "run-1",
    agent: { id: "agent-1", companyId: "co-1", name: "Tester", adapterType: "opencode_remote", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { baseUrl: mock.url, serverPassword: mock.password, allowPrivateNetwork: true, ...config },
    context: { issue: { identifier: "WES-1", title: "Do the thing" } },
    onLog: async (stream: "stdout" | "stderr", chunk: string) => {
      logs.push([stream, chunk]);
    },
    ...rest,
  } as AdapterExecutionContext;
  return { ctx, logs };
}

const paths = () => mock.requests.map((r) => `${r.method} ${r.path}`);

describe("executeWithClient", () => {
  it("runs a turn: creates a session, streams logs, reports usage and session params", async () => {
    const { ctx, logs } = makeCtx();
    const result = await executeWithClient(ctx);

    expect(result.exitCode).toBe(0);
    expect(result.errorCode).toBeUndefined();
    expect(result.summary).toBe("Hello world");
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 25, cachedInputTokens: 50 });
    expect(result.costUsd).toBeCloseTo(0.01);
    expect(result.sessionParams).toEqual({ sessionId: "ses_mock1", baseUrl: mock.url });
    const out = logs.filter(([s]) => s === "stdout").map(([, c]) => c).join("");
    expect(out).toContain("Hello world");
    expect(out).toContain("[tool] bash");
    const prompt = mock.requests.find((r) => r.path.endsWith("/prompt"));
    expect((prompt?.body as { prompt: { text: string } }).prompt.text).toContain("WES-1");
    expect((prompt?.body as { resume: boolean }).resume).toBe(true);
  });

  it("resumes an existing session instead of creating a new one", async () => {
    mock.sessions.add("ses_existing");
    const { ctx } = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: "ses_existing", baseUrl: mock.url },
        sessionDisplayId: null,
        taskKey: null,
      },
    });
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams).toEqual({ sessionId: "ses_existing", baseUrl: mock.url });
    expect(paths()).not.toContain("POST /api/session");
  });

  it("creates a new session when the stored one no longer exists", async () => {
    const { ctx } = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: "ses_gone", baseUrl: mock.url },
        sessionDisplayId: null,
        taskKey: null,
      },
    });
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.sessionParams?.sessionId).toBe("ses_mock1");
  });

  it("does not resume a session recorded for a different server", async () => {
    mock.sessions.add("ses_other");
    const { ctx } = makeCtx({
      runtime: {
        sessionId: null,
        sessionParams: { sessionId: "ses_other", baseUrl: "http://elsewhere.invalid" },
        sessionDisplayId: null,
        taskKey: null,
      },
    });
    const result = await executeWithClient(ctx);
    expect(result.sessionParams?.sessionId).toBe("ses_mock1");
  });

  it("interrupts the remote turn when the run is cancelled", async () => {
    mock.script = [{ type: "session.next.step.started" }, { type: "session.next.text.delta", data: { delta: "working" } }];
    const abort = new AbortController();
    const { ctx } = makeCtx({ signal: abort.signal });
    setTimeout(() => abort.abort(), 100);
    const result = await executeWithClient(ctx);

    expect(result.errorCode).toBe("cancelled");
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
    expect(paths().some((p) => p.endsWith("/interrupt"))).toBe(true);
    expect(result.sessionParams?.sessionId).toBe("ses_mock1");
  });

  it("times out and interrupts when timeoutSec elapses", async () => {
    mock.script = [{ type: "session.next.step.started" }];
    const { ctx } = makeCtx({ config: { timeoutSec: 0.2 } });
    const result = await executeWithClient(ctx);
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("timeout");
    expect(paths().some((p) => p.endsWith("/interrupt"))).toBe(true);
  });

  it("maps a 401 to auth_failed", async () => {
    const { ctx } = makeCtx({ config: { serverPassword: "wrong" } });
    const result = await executeWithClient(ctx);
    expect(result.errorCode).toBe("auth_failed");
    expect(result.exitCode).toBe(1);
  });

  it("reports an unreachable server", async () => {
    const dead = await startMockServer();
    const url = dead.url;
    await dead.close();
    const { ctx } = makeCtx({ config: { baseUrl: url } });
    const result = await executeWithClient(ctx);
    expect(result.errorCode).toBe("unreachable");
  });

  it("classifies a provider rate limit error event", async () => {
    mock.script = [
      { type: "session.next.step.started" },
      { type: "session.error", data: { error: { message: "Free usage exceeded, subscribe to Go" } } },
    ];
    const { ctx } = makeCtx();
    const result = await executeWithClient(ctx);
    expect(result.errorCode).toBe("rate_limited");
    expect(result.errorMessage).toContain("Free usage exceeded");
  });

  it("fails the run when a permission is requested and autoApprove is off", async () => {
    mock.script = [
      { type: "session.next.step.started" },
      { type: "permission.v2.asked", data: { id: "per_1", action: "bash" } },
    ];
    const { ctx } = makeCtx();
    const result = await executeWithClient(ctx);
    expect(result.errorCode).toBe("permission_required");
    expect(paths().some((p) => p.includes("/permission/per_1/reply"))).toBe(true);
    expect(paths().some((p) => p.endsWith("/interrupt"))).toBe(true);
  });

  it("approves permissions once when autoApprove is on", async () => {
    mock.script = [
      { type: "session.next.step.started" },
      { type: "permission.v2.asked", data: { id: "per_1", action: "bash" } },
      { type: "session.idle", delayMs: 40 },
    ];
    const { ctx } = makeCtx({ config: { autoApprove: true } });
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    const reply = mock.requests.find((r) => r.path.includes("/permission/per_1/reply"));
    expect((reply?.body as { reply: string }).reply).toBe("once");
  });

  it("rejects questions so the run can continue", async () => {
    mock.script = [
      { type: "session.next.step.started" },
      { type: "question.v2.asked", data: { id: "que_1" } },
      { type: "session.idle", delayMs: 40 },
    ];
    const { ctx } = makeCtx();
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    expect(paths().some((p) => p.includes("/question/que_1/reject"))).toBe(true);
  });

  it("ignores events for other sessions and an idle that precedes any activity", async () => {
    mock.script = [
      { type: "session.idle" },
      { type: "session.next.step.started" },
      { type: "session.next.text.ended", data: { text: "done" } },
      { type: "session.idle", delayMs: 30 },
    ];
    const { ctx } = makeCtx();
    mock.emit({ type: "session.idle", data: { sessionID: "ses_someone_else" } });
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toBe("done");
  });

  it("never sends the server password in the prompt or logs", async () => {
    const { ctx, logs } = makeCtx();
    await executeWithClient(ctx);
    const prompt = JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body);
    expect(prompt).not.toContain(mock.password);
    expect(logs.flat().join("")).not.toContain(mock.password);
  });

  it("includes the run token in the prompt only when sendRunToken is not disabled", async () => {
    const withToken = makeCtx({ authToken: "run-jwt-123" });
    await executeWithClient(withToken.ctx);
    expect(JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body)).toContain("run-jwt-123");

    mock.requests.length = 0;
    const without = makeCtx({ authToken: "run-jwt-123", config: { sendRunToken: false } });
    await executeWithClient(without.ctx);
    expect(JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body)).not.toContain("run-jwt-123");
  });

  it("rejects invalid config", async () => {
    const { ctx } = makeCtx({ config: { model: "no-slash" } });
    const result = await executeWithClient(ctx);
    expect(result.errorCode).toBe("invalid_config");
  });
});

describe("testEnvironmentWithClient", () => {
  const base = () => ({ companyId: "co-1", adapterType: "opencode_remote" });

  it("passes against a healthy server and reports the version", async () => {
    const result = await testEnvironmentWithClient({
      ...base(),
      config: { baseUrl: mock.url, serverPassword: mock.password, allowPrivateNetwork: true },
    });
    // The mock runs on loopback, so the run opts in to private targets and the check warns about it.
    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "opencode_remote_private_network_allowed")).toBe(true);
    expect(result.checks.some((c) => c.message.includes("1.18.33"))).toBe(true);
  });

  it("fails on bad credentials", async () => {
    const result = await testEnvironmentWithClient({
      ...base(),
      config: { baseUrl: mock.url, serverPassword: "nope", allowPrivateNetwork: true },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "opencode_remote_auth_failed")).toBe(true);
  });

  it("fails on missing config", async () => {
    const result = await testEnvironmentWithClient({ ...base(), config: {} });
    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("opencode_remote_config_invalid");
  });

  it("refuses remote plain http, but allows loopback and the escape hatch", async () => {
    const refused = await testEnvironmentWithClient(
      { ...base(), config: { baseUrl: "http://example.invalid:4096", serverPassword: "x" } },
      () => ({ health: async () => ({ healthy: true, version: "1.0.0" }) }) as never,
    );
    expect(refused.status).toBe("fail");
    expect(refused.checks[0]?.code).toBe("opencode_remote_config_invalid");
    expect(refused.checks[0]?.message).toContain("plain HTTP");

    const allowed = await testEnvironmentWithClient(
      {
        ...base(),
        config: { baseUrl: "http://example.invalid:4096", serverPassword: "x", dangerouslyAllowInsecureRemoteHttp: true },
      },
      () => ({ health: async () => ({ healthy: true, version: "1.0.0" }) }) as never,
    );
    expect(allowed.status).toBe("warn");
    expect(allowed.checks.some((c) => c.code === "opencode_remote_insecure_transport")).toBe(true);
  });
});

describe("compatibility with Paperclip's adapter contract", () => {
  it("declares the flags remote adapters need", () => {
    const adapter = createServerAdapter();
    expect(adapter.type).toBe("opencode_remote");
    expect(adapter.supportsLocalAgentJwt).toBe(true);
    expect(adapter.runtimeToolDelivery).toBe("invocation_context");
    expect(adapter.supportsInstructionsBundle).toBe(true);
    expect(adapter.instructionsPathKey).toBe("instructionsFilePath");
  });

  it("round-trips session params and rejects malformed ones", () => {
    const codec = createServerAdapter().sessionCodec!;
    const params = { sessionId: "ses_1", baseUrl: "https://x.example" };
    expect(codec.deserialize(params)).toEqual(params);
    expect(codec.serialize(params)).toEqual(params);
    expect(codec.getDisplayId?.(params)).toBe("ses_1");
    expect(codec.deserialize({ sessionId: "ses_1" })).toBeNull();
    expect(codec.deserialize("nope")).toBeNull();
  });

  it("marks the server password as a secret in the config schema", async () => {
    const schema = await createServerAdapter().getConfigSchema!();
    const field = schema.fields.find((f) => f.key === "serverPassword");
    expect(field?.meta).toEqual({ secret: true });
    expect(schema.fields.find((f) => f.key === "baseUrl")?.required).toBe(true);
  });

  it("renders the Paperclip wake payload instead of a raw JSON dump", async () => {
    const { ctx } = makeCtx({
      context: { paperclipWake: { reason: "issue_assigned", issue: { id: "i1", identifier: "WES-77", title: "Fix the thing", status: "todo" } } },
    });
    await executeWithClient(ctx);
    const prompt = JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body);
    expect(prompt).toContain("WES-77");
    expect(prompt).not.toContain("Wake context (JSON)");
  });

  it("prefixes agent instructions read from instructionsFilePath", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oc-remote-"));
    process.env.PAPERCLIP_HOME = dir;
    const file = join(dir, "AGENTS.md");
    writeFileSync(file, "Always answer in haiku.");
    const { ctx } = makeCtx({ config: { instructionsFilePath: file } });
    try {
      await executeWithClient(ctx);
    } finally {
      delete process.env.PAPERCLIP_HOME;
    }
    const prompt = JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body);
    expect(prompt).toContain("Always answer in haiku.");
  });

  it("keeps running when the instructions file is missing", async () => {
    const { ctx, logs } = makeCtx({ config: { instructionsFilePath: "/nonexistent/AGENTS.md" } });
    const result = await executeWithClient(ctx);
    expect(result.exitCode).toBe(0);
    expect(logs.some(([s, c]) => s === "stderr" && c.includes("could not read instructions file"))).toBe(true);
  });

  it("delivers runtime tools in the prompt only when sendRunToken is on", async () => {
    const runtimeTools = {
      version: 1 as const,
      guidance: "Use the connections tools.",
      mcpEndpoint: "https://paperclip.example/mcp/runtime-tools",
      rest: { connectionsSearch: "/a", connectionRequest: "/b" },
      bearerToken: "tools-secret-xyz",
      expiresAt: "2030-01-01T00:00:00Z",
      tools: ["connections_search", "connection_request"] as const,
    };
    await executeWithClient(makeCtx({ runtimeTools }).ctx);
    expect(JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body)).toContain("tools-secret-xyz");

    mock.requests.length = 0;
    await executeWithClient(makeCtx({ runtimeTools, config: { sendRunToken: false } }).ctx);
    expect(JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body)).not.toContain("tools-secret-xyz");
  });

  it("reports invocation metadata through onMeta without secrets", async () => {
    const metas: Array<Record<string, unknown>> = [];
    const { ctx } = makeCtx({ onMeta: async (m) => void metas.push(m as unknown as Record<string, unknown>) });
    await executeWithClient(ctx);
    expect(metas).toHaveLength(1);
    expect(metas[0]?.adapterType).toBe("opencode_remote");
    expect(JSON.stringify(metas[0])).not.toContain(mock.password);
  });

  it("redacts run and tools tokens from the reported prompt", async () => {
    const metas: Array<Record<string, unknown>> = [];
    const runtimeTools = { guidance: "g", mcpEndpoint: "http://x/mcp", bearerToken: "tools-secret-xyz", expiresAt: "2030-01-01" };
    const { ctx } = makeCtx({ runtimeTools, authToken: "run-secret-abc", onMeta: async (m) => void metas.push(m as unknown as Record<string, unknown>) });
    await executeWithClient(ctx);
    const meta = JSON.stringify(metas[0]);
    expect(meta).not.toContain("tools-secret-xyz");
    expect(meta).not.toContain("run-secret-abc");
    expect(JSON.stringify(mock.requests.find((r) => r.path.endsWith("/prompt"))?.body)).toContain("run-secret-abc");
  });

  it("keeps the session on a failed prompt so the next run can resume", async () => {
    mock.failPrompt = 500;
    const r = await executeWithClient(makeCtx().ctx);
    expect(r.exitCode).toBe(1);
    expect(r.sessionParams).toMatchObject({ sessionId: expect.any(String) });
  });

  it("classifies failures into Paperclip error families", async () => {
    mock.script = [
      { type: "session.next.step.started" },
      { type: "session.error", data: { error: { message: "Free usage exceeded, subscribe to Go" } } },
    ];
    expect((await executeWithClient(makeCtx().ctx)).errorFamily).toBe("provider_quota");

    mock.script = [
      { type: "session.next.step.started" },
      { type: "session.error", data: { error: { message: "Rate limit exceeded, try again later" } } },
    ];
    expect((await executeWithClient(makeCtx().ctx)).errorFamily).toBe("transient_upstream");

    const dead = await startMockServer();
    const url = dead.url;
    await dead.close();
    expect((await executeWithClient(makeCtx({ config: { baseUrl: url } }).ctx)).errorFamily).toBe("transient_upstream");

    expect((await executeWithClient(makeCtx({ config: { serverPassword: "wrong" } }).ctx)).errorFamily).toBeNull();
  });
});
