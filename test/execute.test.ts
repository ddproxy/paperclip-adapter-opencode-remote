import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { executeWithClient } from "../src/server/execute.js";
import { testEnvironmentWithClient } from "../src/server/test.js";
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
    config: { baseUrl: mock.url, serverPassword: mock.password, ...config },
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
      config: { baseUrl: mock.url, serverPassword: mock.password },
    });
    expect(result.status).toBe("pass");
    expect(result.checks.some((c) => c.message.includes("1.18.33"))).toBe(true);
  });

  it("fails on bad credentials", async () => {
    const result = await testEnvironmentWithClient({
      ...base(),
      config: { baseUrl: mock.url, serverPassword: "nope" },
    });
    expect(result.status).toBe("fail");
    expect(result.checks.some((c) => c.code === "opencode_remote_auth_failed")).toBe(true);
  });

  it("fails on missing config", async () => {
    const result = await testEnvironmentWithClient({ ...base(), config: {} });
    expect(result.status).toBe("fail");
    expect(result.checks[0]?.code).toBe("opencode_remote_config_invalid");
  });

  it("warns on plain http to a non-private host", async () => {
    const result = await testEnvironmentWithClient(
      { ...base(), config: { baseUrl: "http://example.invalid:4096", serverPassword: "x" } },
      () => ({
        health: async () => ({ healthy: true, version: "1.0.0" }),
      }) as never,
    );
    expect(result.status).toBe("warn");
    expect(result.checks.some((c) => c.code === "opencode_remote_insecure_transport")).toBe(true);
  });
});
