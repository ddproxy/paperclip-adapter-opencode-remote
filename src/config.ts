export interface RemoteConfig {
  baseUrl: string;
  username: string;
  serverPassword: string;
  model: { providerID: string; id: string } | null;
  agent: string | null;
  directory: string | null;
  timeoutSec: number;
  autoApprove: boolean;
  sendRunToken: boolean;
  paperclipApiUrl: string;
  promptTemplate: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

export function parseConfig(config: Record<string, unknown>): RemoteConfig {
  const baseUrl = str(config.baseUrl);
  if (!baseUrl) throw new ConfigError("baseUrl is required");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new ConfigError(`baseUrl is not a valid URL: ${baseUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConfigError("baseUrl must be http or https");
  }
  const serverPassword = str(config.serverPassword);
  if (!serverPassword) throw new ConfigError("serverPassword is required");

  let model: RemoteConfig["model"] = null;
  const modelRaw = str(config.model);
  if (modelRaw) {
    const slash = modelRaw.indexOf("/");
    if (slash <= 0 || slash === modelRaw.length - 1) {
      throw new ConfigError(`model must be in provider/model format, got: ${modelRaw}`);
    }
    model = { providerID: modelRaw.slice(0, slash), id: modelRaw.slice(slash + 1) };
  }

  const timeout = Number(config.timeoutSec ?? 0);
  return {
    baseUrl: url.toString().replace(/\/+$/, ""),
    username: str(config.username) ?? "opencode",
    serverPassword,
    model,
    agent: str(config.agent),
    directory: str(config.directory),
    timeoutSec: Number.isFinite(timeout) && timeout > 0 ? timeout : 0,
    autoApprove: config.autoApprove === true,
    sendRunToken: config.sendRunToken !== false,
    paperclipApiUrl: str(config.paperclipApiUrl) ?? process.env.PAPERCLIP_API_URL ?? "",
    promptTemplate: str(config.promptTemplate),
  };
}
