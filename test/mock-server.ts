import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockEvent {
  type: string;
  data?: Record<string, unknown>;
  delayMs?: number;
}

export interface MockServer {
  url: string;
  password: string;
  requests: Array<{ method: string; path: string; body: unknown }>;
  sessions: Set<string>;
  /** Events emitted on the SSE stream after each prompt. Mutate between runs. */
  script: MockEvent[];
  /** Emit extra events to open streams right now. */
  emit(event: MockEvent): void;
  close(): Promise<void>;
}

export async function startMockServer(opts: { password?: string; version?: string } = {}): Promise<MockServer> {
  const password = opts.password ?? "test-password";
  const expected = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
  const streams = new Set<ServerResponse>();
  let counter = 0;

  const mock: MockServer = {
    url: "",
    password,
    requests: [],
    sessions: new Set(),
    script: [],
    emit(event) {
      const frame = `data: ${JSON.stringify({ type: event.type, data: event.data ?? {} })}\n\n`;
      for (const res of streams) res.write(frame);
    },
    close: () =>
      new Promise((resolve) => {
        for (const res of streams) res.end();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };

  const readBody = (req: IncomingMessage): Promise<unknown> =>
    new Promise((resolve) => {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        try {
          resolve(raw ? JSON.parse(raw) : null);
        } catch {
          resolve(raw);
        }
      });
    });

  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server: Server = createServer(async (req, res) => {
    const path = (req.url ?? "").split("?")[0];
    const body = await readBody(req);
    mock.requests.push({ method: req.method ?? "GET", path, body });

    if (req.headers.authorization !== expected) {
      return json(res, 401, { _tag: "UnauthorizedError", message: "unauthorized" });
    }
    if (path === "/global/health") return json(res, 200, { healthy: true, version: opts.version ?? "1.18.33" });

    if (path === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.write(": connected\n\n");
      streams.add(res);
      req.on("close", () => streams.delete(res));
      return;
    }

    if (path === "/api/session" && req.method === "POST") {
      const id = `ses_mock${++counter}`;
      mock.sessions.add(id);
      return json(res, 200, { data: { id } });
    }

    const m = path.match(/^\/api\/session\/([^/]+)(?:\/(.*))?$/);
    if (m) {
      const [, id, rest] = m;
      if (!mock.sessions.has(id)) return json(res, 404, { _tag: "SessionNotFoundError" });
      if (!rest && req.method === "GET") return json(res, 200, { data: { id } });
      if (rest === "prompt" && req.method === "POST") {
        json(res, 200, { data: { id: "msg_1", sessionID: id } });
        let at = 0;
        for (const ev of mock.script) {
          at += ev.delayMs ?? 5;
          setTimeout(() => mock.emit({ type: ev.type, data: { sessionID: id, ...(ev.data ?? {}) } }), at);
        }
        return;
      }
      if (rest === "interrupt" && req.method === "POST") {
        res.writeHead(204).end();
        setTimeout(() => mock.emit({ type: "session.idle", data: { sessionID: id } }), 5);
        return;
      }
      if (/^(permission|question)\//.test(rest ?? "") && req.method === "POST") {
        return void res.writeHead(204).end();
      }
    }
    json(res, 404, { error: "not found", path });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  mock.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return mock;
}

export const happyScript: MockEvent[] = [
  { type: "session.next.step.started" },
  { type: "session.next.text.delta", data: { delta: "Hello " } },
  { type: "session.next.text.delta", data: { delta: "world" } },
  { type: "session.next.tool.called", data: { tool: "bash", input: { command: "ls" } } },
  { type: "session.next.text.ended", data: { text: "Hello world" } },
  {
    type: "session.next.step.ended",
    data: { cost: 0.01, tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 50, write: 0 } } },
  },
  { type: "session.idle" },
];
