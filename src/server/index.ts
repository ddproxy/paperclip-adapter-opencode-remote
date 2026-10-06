import type { AdapterSessionCodec, ServerAdapterModule } from "@paperclipai/adapter-utils";
import { getConfigSchema } from "../config-schema.js";
import { agentConfigurationDoc, models, type } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const sessionCodec: AdapterSessionCodec = {
  deserialize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    const sessionId = typeof r.sessionId === "string" && r.sessionId ? r.sessionId : null;
    const baseUrl = typeof r.baseUrl === "string" && r.baseUrl ? r.baseUrl : null;
    return sessionId && baseUrl ? { sessionId, baseUrl } : null;
  },
  serialize(params) {
    return sessionCodec.deserialize(params);
  },
  getDisplayId(params) {
    const parsed = sessionCodec.deserialize(params);
    return parsed ? (parsed.sessionId as string) : null;
  },
};

export function createServerAdapter(): ServerAdapterModule {
  return {
    type,
    execute,
    testEnvironment,
    sessionCodec,
    models,
    getConfigSchema,
    agentConfigurationDoc,
    // Without this the server never mints the run token, and a remote agent cannot call Paperclip back.
    supportsLocalAgentJwt: true,
    runtimeToolDelivery: "invocation_context",
    supportsInstructionsBundle: true,
    instructionsPathKey: "instructionsFilePath",
  };
}
