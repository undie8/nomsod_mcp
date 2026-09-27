import http from "node:http";
import { URL } from "node:url";
import { getNomsodVersion } from "../shared/version.js";
import { executeAction } from "./actions.js";

const host = "127.0.0.1";
const port = Number(process.env.NOMSOD_AGENT_WORKER_PORT || 3230);
const version = getNomsodVersion(process.cwd());

async function readJsonBody(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) throw new Error("request body too large");
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(res: http.ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "nomsod-agent-worker",
      version,
      pid: process.pid
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/execute") {
    try {
      const body = await readJsonBody(req);
      const method = typeof body.method === "string" ? body.method : "";
      if (!method) throw new Error("method is required");
      const result = await executeAction(method, body.params);
      sendJson(res, 200, { result });
    } catch (error) {
      sendJson(res, 500, {
        error: error instanceof Error ? error.message : String(error)
      });
    }
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 310_000;

server.listen(port, host, () => {
  console.log(`[agent-worker] listening on http://${host}:${port}`);
});

function exitWhenParentDisconnects(label: string): void {
  if (!process.connected) return;

  process.once("disconnect", () => {
    console.warn(`[${label}] parent IPC disconnected; exiting to avoid orphan process`);

    const forceTimer = setTimeout(() => process.exit(0), 2_000);
    forceTimer.unref();

    server.close(() => process.exit(0));
  });
}

exitWhenParentDisconnects("agent-worker");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
