import type {
  AdapterEnvironmentCheck,
  AdapterEnvironmentTestContext,
  AdapterEnvironmentTestResult,
} from "@paperclipai/adapter-utils";
import { OpencodeHttpError, OpencodeUnreachableError } from "../client.js";
import { ConfigError, parseConfig } from "../config.js";
import { defaultClientFactory, type ClientFactory } from "./execute.js";

export async function testEnvironmentWithClient(
  ctx: AdapterEnvironmentTestContext,
  makeClient: ClientFactory = defaultClientFactory,
): Promise<AdapterEnvironmentTestResult> {
  const checks: AdapterEnvironmentCheck[] = [];
  const done = (): AdapterEnvironmentTestResult => ({
    adapterType: ctx.adapterType,
    status: checks.some((c) => c.level === "error") ? "fail" : checks.some((c) => c.level === "warn") ? "warn" : "pass",
    checks,
    testedAt: new Date().toISOString(),
  });

  let cfg;
  try {
    cfg = parseConfig(ctx.config);
  } catch (err) {
    checks.push({
      code: "opencode_remote_config_invalid",
      level: "error",
      message: err instanceof ConfigError ? err.message : "Invalid adapter configuration",
      hint: "Set baseUrl and serverPassword (and optionally model as provider/model).",
    });
    return done();
  }

  const url = new URL(cfg.baseUrl);
  if (url.protocol === "http:" && !/^(localhost|::1|\[::1\]|127(\.\d{1,3}){3})$/i.test(url.hostname)) {
    checks.push({
      code: "opencode_remote_insecure_transport",
      level: "warn",
      message: `baseUrl uses plain http to ${url.hostname}`,
      hint: "dangerouslyAllowInsecureRemoteHttp is on: credentials and prompts cross the network unencrypted.",
    });
  }

  try {
    const health = await makeClient(cfg).health();
    if (!health.healthy) {
      checks.push({ code: "opencode_remote_unhealthy", level: "error", message: "opencode server reports unhealthy" });
    } else {
      checks.push({
        code: "opencode_remote_reachable",
        level: "info",
        message: `opencode server reachable and authenticated${health.version ? ` (version ${health.version})` : ""}`,
      });
    }
  } catch (err) {
    if (err instanceof OpencodeHttpError && err.status === 401) {
      checks.push({
        code: "opencode_remote_auth_failed",
        level: "error",
        message: "opencode server rejected the credentials",
        hint: "Check serverPassword (and username, default `opencode`).",
      });
    } else if (err instanceof OpencodeUnreachableError) {
      checks.push({
        code: "opencode_remote_unreachable",
        level: "error",
        message: err.message,
        hint: "The Paperclip pod needs an outbound HTTPS path to this host.",
      });
    } else {
      checks.push({
        code: "opencode_remote_probe_failed",
        level: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return done();
}

export const testEnvironment = (ctx: AdapterEnvironmentTestContext) => testEnvironmentWithClient(ctx);
