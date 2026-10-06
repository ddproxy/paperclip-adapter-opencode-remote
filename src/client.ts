// All opencode server HTTP lives here so a mock can replace it and endpoint
// corrections stay in one place. Endpoint shapes come from SPEC-opencode-api.md.

export interface OpencodeEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface OpencodeClientOptions {
  baseUrl: string;
  username: string;
  password: string;
  requestTimeoutMs?: number;
}

export interface SessionCreateOptions {
  agent?: string;
  model?: { providerID: string; id: string };
  directory?: string;
}

export interface OpencodeClient {
  health(): Promise<{ healthy: boolean; version: string | null }>;
  createSession(opts: SessionCreateOptions): Promise<{ id: string }>;
  sessionExists(id: string): Promise<boolean>;
  prompt(sessionId: string, text: string): Promise<void>;
  /** Resolves once the stream is connected, so no event is missed after prompt(). */
  subscribe(signal: AbortSignal): Promise<AsyncIterable<OpencodeEvent>>;
  interrupt(sessionId: string): Promise<void>;
  replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void>;
  rejectQuestion(sessionId: string, requestId: string): Promise<void>;
}

export class OpencodeHttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "OpencodeHttpError";
  }
}

export class OpencodeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpencodeUnreachableError";
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export class HttpOpencodeClient implements OpencodeClient {
  private readonly authHeader: string;
  private readonly base: string;
  private readonly timeoutMs: number;

  constructor(opts: OpencodeClientOptions) {
    this.base = opts.baseUrl.replace(/\/+$/, "");
    this.authHeader = `Basic ${Buffer.from(`${opts.username}:${opts.password}`).toString("base64")}`;
    this.timeoutMs = opts.requestTimeoutMs ?? 30_000;
  }

  private async fetchRaw(path: string, init: RequestInit & { timeout?: boolean } = {}): Promise<Response> {
    const { timeout = true, ...rest } = init;
    const headers = new Headers(rest.headers);
    headers.set("authorization", this.authHeader);
    if (rest.body !== undefined && !headers.has("content-type")) headers.set("content-type", "application/json");
    const signals: AbortSignal[] = [];
    if (rest.signal) signals.push(rest.signal);
    if (timeout) signals.push(AbortSignal.timeout(this.timeoutMs));
    try {
      return await fetch(`${this.base}${path}`, {
        ...rest,
        headers,
        signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
      });
    } catch (err) {
      if (rest.signal?.aborted) throw err;
      const cause = err instanceof Error ? (err.cause as { code?: string } | undefined)?.code : undefined;
      throw new OpencodeUnreachableError(
        `Cannot reach ${this.base}${cause ? ` (${cause})` : ""}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async json(path: string, init: RequestInit = {}): Promise<unknown> {
    const res = await this.fetchRaw(path, init);
    const text = await res.text();
    if (!res.ok) throw new OpencodeHttpError(res.status, `HTTP ${res.status} from ${path}: ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
  }

  async health(): Promise<{ healthy: boolean; version: string | null }> {
    const body = asRecord(await this.json("/global/health"));
    return {
      healthy: body.healthy === true,
      version: typeof body.version === "string" ? body.version : null,
    };
  }

  async createSession(opts: SessionCreateOptions): Promise<{ id: string }> {
    const body: Record<string, unknown> = {};
    if (opts.agent) body.agent = opts.agent;
    if (opts.model) body.model = opts.model;
    if (opts.directory) body.location = { directory: opts.directory };
    const res = asRecord(asRecord(await this.json("/api/session", { method: "POST", body: JSON.stringify(body) })).data);
    if (typeof res.id !== "string") throw new Error("Session create response had no id");
    return { id: res.id };
  }

  async sessionExists(id: string): Promise<boolean> {
    try {
      await this.json(`/api/session/${encodeURIComponent(id)}`);
      return true;
    } catch (err) {
      if (err instanceof OpencodeHttpError && err.status === 404) return false;
      throw err;
    }
  }

  async prompt(sessionId: string, text: string): Promise<void> {
    // TODO(verify): resume:true is documented as "schedules agent execution".
    await this.json(`/api/session/${encodeURIComponent(sessionId)}/prompt`, {
      method: "POST",
      body: JSON.stringify({ prompt: { text }, resume: true }),
    });
  }

  async subscribe(signal: AbortSignal): Promise<AsyncIterable<OpencodeEvent>> {
    // TODO(verify): SSE framing (one JSON object per `data:` line, shaped {type, data}).
    const res = await this.fetchRaw("/api/event", {
      headers: { accept: "text/event-stream" },
      signal,
      timeout: false,
    });
    if (!res.ok || !res.body) {
      throw new OpencodeHttpError(res.status, `HTTP ${res.status} opening event stream`);
    }
    return parseSse(res.body);
  }

  async interrupt(sessionId: string): Promise<void> {
    const res = await this.fetchRaw(`/api/session/${encodeURIComponent(sessionId)}/interrupt`, { method: "POST" });
    if (!res.ok && res.status !== 404) throw new OpencodeHttpError(res.status, `HTTP ${res.status} on interrupt`);
  }

  async replyPermission(sessionId: string, requestId: string, reply: "once" | "always" | "reject"): Promise<void> {
    const res = await this.fetchRaw(
      `/api/session/${encodeURIComponent(sessionId)}/permission/${encodeURIComponent(requestId)}/reply`,
      { method: "POST", body: JSON.stringify({ reply, message: "Resolved by Paperclip opencode_remote adapter" }) },
    );
    if (!res.ok) throw new OpencodeHttpError(res.status, `HTTP ${res.status} on permission reply`);
  }

  async rejectQuestion(sessionId: string, requestId: string): Promise<void> {
    const res = await this.fetchRaw(
      `/api/session/${encodeURIComponent(sessionId)}/question/${encodeURIComponent(requestId)}/reject`,
      { method: "POST" },
    );
    if (!res.ok) throw new OpencodeHttpError(res.status, `HTTP ${res.status} on question reject`);
  }
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<OpencodeEvent> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let sep: number;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = raw
          .split(/\r?\n/)
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).replace(/^ /, ""))
          .join("\n");
        if (!data) continue;
        const event = normalizeEvent(data);
        if (event) yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function normalizeEvent(data: string): OpencodeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  const obj = asRecord(parsed);
  if (typeof obj.type !== "string") return null;
  return { type: obj.type, data: asRecord(obj.data ?? obj.properties) };
}
