import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterExecutionContext } from "@paperclipai/adapter-utils";
import { HttpOpencodeClient, parseSse } from "../src/client.js";
import { assertPublicHost, isBlockedAddress, NetworkGuardError } from "../src/net-guard.js";
import { executeWithClient } from "../src/server/execute.js";
import { InstructionsPathError, readInstructionsFile } from "../src/server/instructions.js";
import { testEnvironmentWithClient } from "../src/server/test.js";
import { startMockServer } from "./mock-server.js";

const savedHome = process.env.PAPERCLIP_HOME;
afterEach(() => {
  if (savedHome === undefined) delete process.env.PAPERCLIP_HOME;
  else process.env.PAPERCLIP_HOME = savedHome;
});

function ctx(config: Record<string, unknown>): AdapterExecutionContext {
  return {
    runId: "r",
    agent: { id: "a", companyId: "c", name: "T", adapterType: "opencode_remote", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config,
    context: {},
    onLog: async () => undefined,
  } as AdapterExecutionContext;
}

describe("SSRF guard", () => {
  it("classifies non-public addresses", () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "224.0.0.1"]) {
      expect(isBlockedAddress(a), a).toBe(true);
    }
    for (const a of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.255.255", "193.0.0.1", "2606:4700:4700::1111"]) {
      expect(isBlockedAddress(a), a).toBe(false);
    }
  });

  it("refuses literal private addresses and unresolvable names", async () => {
    await expect(assertPublicHost("169.254.169.254")).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(assertPublicHost("[::1]")).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(assertPublicHost("no-such-host.invalid")).rejects.toBeInstanceOf(NetworkGuardError);
    await expect(assertPublicHost("8.8.8.8")).resolves.toBeUndefined();
  });

  it("blocks a run to a loopback server by default, and allows it when opted in", async () => {
    const mock = await startMockServer();
    try {
      const blocked = await executeWithClient(ctx({ baseUrl: mock.url, serverPassword: mock.password }));
      expect(blocked.errorCode).toBe("blocked_network");
      expect(mock.requests).toHaveLength(0);
      const allowed = await testEnvironmentWithClient(
        { companyId: "c", adapterType: "opencode_remote", config: { baseUrl: mock.url, serverPassword: mock.password, allowPrivateNetwork: true } },
      );
      expect(allowed.status).toBe("warn");
      expect(allowed.checks.some((c) => c.code === "opencode_remote_private_network_allowed")).toBe(true);
    } finally {
      await mock.close();
    }
  });

  it("reports the guard in the environment test", async () => {
    const res = await testEnvironmentWithClient({
      companyId: "c",
      adapterType: "opencode_remote",
      config: { baseUrl: "https://169.254.169.254", serverPassword: "x" },
    });
    expect(res.status).toBe("fail");
    expect(res.checks.some((c) => c.code === "opencode_remote_blocked_network")).toBe(true);
  });
});

describe("redirects", () => {
  it("never follows a redirect (credentials would travel with it)", async () => {
    let followed = false;
    const target = createServer((_, res) => {
      followed = true;
      res.end("{}");
    });
    await new Promise<void>((r) => target.listen(0, "127.0.0.1", r));
    const tport = (target.address() as AddressInfo).port;
    const redirector = createServer((_, res) => {
      res.writeHead(302, { location: `http://127.0.0.1:${tport}/global/health` }).end();
    });
    await new Promise<void>((r) => redirector.listen(0, "127.0.0.1", r));
    const port = (redirector.address() as AddressInfo).port;
    try {
      const client = new HttpOpencodeClient({ baseUrl: `http://127.0.0.1:${port}`, username: "opencode", password: "p", allowPrivateNetwork: true });
      await expect(client.health()).rejects.toThrow();
      expect(followed).toBe(false);
    } finally {
      redirector.close();
      target.close();
    }
  });
});

describe("SSE parser limits", () => {
  it("aborts when a frame never terminates", async () => {
    const chunk = "data: " + "x".repeat(1024 * 1024);
    let sent = 0;
    const body = Readable.toWeb(
      new Readable({
        read() {
          this.push(sent++ < 12 ? chunk : null);
        },
      }),
    ) as ReadableStream<Uint8Array>;
    const events = parseSse(body);
    await expect((async () => { for await (const _ of events) { /* drain */ } })()).rejects.toThrow(/buffer limit/);
  });
});

describe("instructions file confinement", () => {
  it("reads a markdown file under the Paperclip home", async () => {
    const home = mkdtempSync(join(tmpdir(), "pc-home-"));
    process.env.PAPERCLIP_HOME = home;
    const f = join(home, "AGENTS.md");
    writeFileSync(f, "be terse");
    expect(await readInstructionsFile(f)).toBe("be terse");
  });

  it("rejects files outside the home, wrong types, oversize files and symlink escapes", async () => {
    const home = mkdtempSync(join(tmpdir(), "pc-home-"));
    const outside = mkdtempSync(join(tmpdir(), "pc-outside-"));
    process.env.PAPERCLIP_HOME = home;
    writeFileSync(join(outside, "secret.md"), "outside");
    writeFileSync(join(home, "key.pem"), "key");
    writeFileSync(join(home, "big.md"), "x".repeat(600 * 1024));
    mkdirSync(join(home, "links"));
    symlinkSync(join(outside, "secret.md"), join(home, "links", "escape.md"));

    await expect(readInstructionsFile(join(outside, "secret.md"))).rejects.toBeInstanceOf(InstructionsPathError);
    await expect(readInstructionsFile(join(home, "key.pem"))).rejects.toBeInstanceOf(InstructionsPathError);
    await expect(readInstructionsFile(join(home, "big.md"))).rejects.toBeInstanceOf(InstructionsPathError);
    await expect(readInstructionsFile(join(home, "links", "escape.md"))).rejects.toBeInstanceOf(InstructionsPathError);
    await expect(readInstructionsFile("/etc/passwd")).rejects.toBeInstanceOf(InstructionsPathError);
  });
});
