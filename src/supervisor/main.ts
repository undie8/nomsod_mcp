import { randomBytes } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { AgentHub } from "../gateway/agent-hub.js";
import { OAuthService } from "../gateway/oauth.js";
import { DeviceRegistry } from "../gateway/registry.js";
import { ReleaseManager } from "./release-manager.js";
import { RuntimeManager } from "./runtime-manager.js";
import { getNomsodVersion } from "../shared/version.js";
import { serveDistribution } from "./distribution.js";

const root = process.cwd();
const version = getNomsodVersion(root);
const host = process.env.NOMSOD_GATEWAY_HOST || "127.0.0.1";
const port = Number(process.env.NOMSOD_GATEWAY_PORT || 3219);
const controlPort = Number(process.env.NOMSOD_CONTROL_PORT || port + 2);
const runtimePorts: [number, number] = [
  Number(process.env.NOMSOD_RUNTIME_PORT_A || port + 1),
  Number(process.env.NOMSOD_RUNTIME_PORT_B || port + 3)
];
const pairingToken = process.env.NOMSOD_PAIRING_TOKEN || "";
const ownerKey = process.env.NOMSOD_OWNER_KEY || "";
const publicBase = (process.env.NOMSOD_PUBLIC_BASE_URL || `http://${host}:${port}`).replace(/\/$/, "");
const controlKey = "nsc_" + randomBytes(32).toString("base64url");

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(value));
}

async function readJsonBody(req: IncomingMessage, maxBytes = 2 * 1024 * 1024): Promise<any> {
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

if (!pairingToken) {
  console.warn("[supervisor] NOMSOD_PAIRING_TOKEN is empty; new devices cannot pair.");
}
if (!ownerKey) {
  console.warn("[supervisor] NOMSOD_OWNER_KEY is empty; OAuth authorization will be denied.");
}

const registry = new DeviceRegistry();
await registry.load();

const oauth = new OAuthService(publicBase, ownerKey);
await oauth.initialize();

const hub = new AgentHub(registry, pairingToken);
const releaseManager = new ReleaseManager(root);
const runtimeManager = new RuntimeManager(
  root,
  controlPort,
  controlKey,
  runtimePorts,
  releaseManager,
  Number(process.env.NOMSOD_RUNTIME_DRAIN_TIMEOUT_MS || 300_000)
);

await runtimeManager.initialize();

const controlServer = http.createServer(async (req, res) => {
  if (req.headers["x-nomsod-control-key"] !== controlKey) {
    sendJson(res, 401, { error: "unauthorized" });
    return;
  }

  const url = new URL(req.url || "/", `http://127.0.0.1:${controlPort}`);

  try {
    if (req.method === "GET" && url.pathname === "/devices") {
      sendJson(res, 200, { devices: hub.listDevices() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/request") {
      const body = await readJsonBody(req);
      const result = await hub.request(
        String(body.deviceId || ""),
        String(body.method || ""),
        body.params,
        typeof body.timeoutMs === "number" ? body.timeoutMs : undefined
      );
      sendJson(res, 200, { result });
      return;
    }

    if (req.method === "POST" && url.pathname === "/reload") {
      sendJson(res, 200, await runtimeManager.reload());
      return;
    }

    if (req.method === "POST" && url.pathname === "/rollback") {
      sendJson(res, 200, await runtimeManager.rollback());
      return;
    }

    if (req.method === "GET" && url.pathname === "/runtime") {
      sendJson(res, 200, {
        supervisorPid: process.pid,
        ...runtimeManager.status()
      });
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    sendJson(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  }
});

controlServer.listen(controlPort, "127.0.0.1", () => {
  console.log(`[supervisor] internal control: http://127.0.0.1:${controlPort}`);
});

const publicServer = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "Authorization,Content-Type,MCP-Protocol-Version,Mcp-Method,Mcp-Name"
    });
    res.end();
    return;
  }

  if (await serveDistribution(req, res, url, root)) return;

  if (url.pathname === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "nomsod-supervisor",
      version,
      supervisorPid: process.pid,
      connectedDevices: hub.listDevices().length,
      transport: "streamable-http-stateless",
      publicBase,
      runtime: runtimeManager.status().active
    });
    return;
  }

  if (await oauth.handle(req, res, url)) return;

  if (url.pathname === "/devices" && req.method === "GET") {
    if (!(await oauth.isAuthorized(req))) {
      oauth.challenge(res);
      return;
    }
    sendJson(res, 200, { devices: hub.listDevices() });
    return;
  }

  if (url.pathname === "/mcp") {
    if (!(await oauth.isAuthorized(req))) {
      oauth.challenge(res);
      return;
    }
    runtimeManager.proxy(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
});

publicServer.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname !== "/agent") {
    socket.destroy();
    return;
  }

  hub.handleUpgrade(req, socket, head);
});

publicServer.keepAliveTimeout = 65_000;
publicServer.headersTimeout = 70_000;
publicServer.requestTimeout = 310_000;

publicServer.listen(port, host, () => {
  console.log(`[supervisor] Nomsod MCP public gateway: http://${host}:${port}`);
  console.log(`[supervisor] public MCP endpoint: ${publicBase}/mcp`);
  console.log(`[supervisor] agent endpoint: ws://${host}:${port}/agent`);
});

let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log("[supervisor] shutting down");
  await runtimeManager.shutdown();

  await Promise.all([
    new Promise<void>(resolve => publicServer.close(() => resolve())),
    new Promise<void>(resolve => controlServer.close(() => resolve()))
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}
