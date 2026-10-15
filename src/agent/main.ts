import { execFileSync } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import { URL } from "node:url";
import WebSocket from "ws";
import { buildDescriptor, loadIdentity, saveIdentity } from "../shared/identity.js";
import type { AgentRequest, AgentToGateway, GatewayToAgent } from "../shared/protocol.js";
import { getNomsodVersion } from "../shared/version.js";
import { AgentWorkerManager } from "./worker-manager.js";
import { JobManager } from "./job-manager.js";
import {
  hasConnectedPrimaryGateway,
  isFallbackGatewayUrl,
  shouldParkFallbackGateway
} from "./gateway-routing.js";
import { resolveClusterId } from "../shared/single-cluster.js";

const root = process.cwd();
const version = getNomsodVersion(root);
const clusterId = resolveClusterId();
const gatewayPort = Number(process.env.NOMSOD_GATEWAY_PORT || 3219);
const peerPort = Number(process.env.NOMSOD_PEER_PORT || gatewayPort + 5);
const legacyGatewayUrl = process.env.NOMSOD_GATEWAY_WS || ("ws://127.0.0.1:" + gatewayPort + "/agent");
const localGatewayUrl = "ws://127.0.0.1:" + gatewayPort + "/agent";
const configuredGatewayUrls = (process.env.NOMSOD_GATEWAY_WS_LIST || legacyGatewayUrl)
  .split(/[;,\s]+/)
  .map(value => value.trim())
  .filter(Boolean);
const gatewayUrls = new Set<string>([localGatewayUrl, ...configuredGatewayUrls]);
const pairingToken = process.env.NOMSOD_PAIRING_TOKEN || "";
const heartbeatMs = Number(process.env.NOMSOD_HEARTBEAT_MS || 15_000);
const staleMs = Number(process.env.NOMSOD_STALE_MS || 45_000);
const workerPorts: [number, number] = [
  Number(process.env.NOMSOD_AGENT_WORKER_PORT_A || 3230),
  Number(process.env.NOMSOD_AGENT_WORKER_PORT_B || 3231)
];
const healthPort = Number(process.env.NOMSOD_AGENT_GUARDIAN_HEALTH_PORT || 3232);
const dnsServers = (process.env.NOMSOD_DNS_SERVERS || "1.1.1.1,8.8.8.8")
  .split(",")
  .map(value => value.trim())
  .filter(Boolean);
const fallbackResolver = new dns.promises.Resolver();
fallbackResolver.setServers(dnsServers);

let stopping = false;
let healthServer: http.Server | undefined;
const connectedGateways = new Set<string>();
const sockets = new Set<WebSocket>();
const socketByGatewayUrl = new Map<string, WebSocket>();
const hubIdByGatewayUrl = new Map<string, string>();
const discoveredPeerUrls = new Set<string>();
const reconnectAttempts = new Map<string, number>();
const connectingGateways = new Set<string>();
let peerDiscoveryTimer: NodeJS.Timeout | undefined;
let fallbackGatewayTimer: NodeJS.Timeout | undefined;
let sleepDetectorTimer: NodeJS.Timeout | undefined;
let identityWriteChain: Promise<void> = Promise.resolve();

function resilientLookup(
  hostname: string,
  options: any,
  callback: (...args: any[]) => void
): void {
  dns.lookup(hostname, options, async (error: NodeJS.ErrnoException | null, address: any, family: any) => {
    if (!error) {
      if (options && typeof options === "object" && options.all === true) {
        callback(null, address);
      } else {
        callback(null, address, family);
      }
      return;
    }

    if (!["ENOTFOUND", "EAI_AGAIN"].includes(error.code || "")) {
      callback(error);
      return;
    }

    try {
      const [v4, v6] = await Promise.allSettled([
        fallbackResolver.resolve4(hostname),
        fallbackResolver.resolve6(hostname)
      ]);

      const addresses: Array<{ address: string; family: 4 | 6 }> = [];
      if (v4.status === "fulfilled") {
        addresses.push(...v4.value.map(address => ({ address, family: 4 as const })));
      }
      if (v6.status === "fulfilled") {
        addresses.push(...v6.value.map(address => ({ address, family: 6 as const })));
      }

      if (addresses.length === 0) {
        callback(error);
        return;
      }

      console.warn(
        `[agent-guardian] system DNS failed for ${hostname}; using fallback DNS ${dnsServers.join(",")}`
      );

      if (options && typeof options === "object" && options.all === true) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    } catch {
      callback(error);
    }
  });
}

function tailscaleCliCandidates(): string[] {
  const configured = (process.env.NOMSOD_TAILSCALE_CLI || "").trim();
  const candidates = process.platform === "win32"
    ? [
        configured,
        "C:\Program Files\Tailscale\tailscale.exe",
        "C:\Program Files (x86)\Tailscale\tailscale.exe",
        "tailscale.exe"
      ]
    : [
        configured,
        "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
        "/opt/homebrew/bin/tailscale",
        "/usr/local/bin/tailscale",
        "tailscale"
      ];

  return [...new Set(candidates.filter(Boolean))];
}

function discoverTailscaleGatewayUrls(): string[] {
  for (const executable of tailscaleCliCandidates()) {
    try {
      const raw = execFileSync(executable, ["status", "--json"], {
        encoding: "utf8",
        timeout: 3_000,
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"]
      });

      const status = JSON.parse(raw) as {
        Peer?: Record<string, { Online?: boolean; TailscaleIPs?: string[] }>;
      };

      const urls: string[] = [];
      for (const peer of Object.values(status.Peer || {})) {
        if (peer.Online !== true) continue;
        const address = (peer.TailscaleIPs || []).find(value => /^100\./.test(value));
        if (!address) continue;
        urls.push("ws://" + address + ":" + peerPort + "/agent");
      }
      return urls;
    } catch {
      continue;
    }
  }

  return [];
}
async function probeNomsodPeerGateway(gatewayUrl: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(gatewayUrl.replace(/^ws:/, "http:"));
    url.pathname = "/health";
    url.search = "";
  } catch {
    return false;
  }

  return new Promise(resolve => {
    const req = http.get(url, { timeout: 1_200 }, res => {
      const chunks: Buffer[] = [];
      let size = 0;

      res.on("data", chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= 16 * 1024) chunks.push(buffer);
      });

      res.on("end", () => {
        if (res.statusCode !== 200 || size > 16 * 1024) {
          resolve(false);
          return;
        }

        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          resolve(
            body?.ok === true &&
            body?.service === "nomsod-peer" &&
            (body?.clusterId === undefined || body?.clusterId === clusterId)
          );
        } catch {
          resolve(false);
        }
      });
    });

    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
    req.on("error", () => resolve(false));
  });
}
function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const jitter = Math.floor(Math.random() * Math.max(250, base * 0.25));
  return base + jitter;
}

const workerManager = new AgentWorkerManager(
  root,
  workerPorts,
  undefined,
  Number(process.env.NOMSOD_AGENT_DRAIN_TIMEOUT_MS || 300_000)
);

const jobManager = new JobManager();

async function handleRequest(request: AgentRequest): Promise<unknown> {
  if (request.method === "agent.runtime_status") {
    return workerManager.status();
  }

  if (request.method === "agent.reload_runtime") {
    return workerManager.reload();
  }

  if (request.method === "agent.rollback_runtime") {
    return workerManager.rollback();
  }

  if (request.method === "job.start") {
    const params = (request.params && typeof request.params === "object"
      ? request.params
      : {}) as Record<string, unknown>;
    return jobManager.start({
      command: String(params.command || ""),
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      shell: typeof params.shell === "string" ? params.shell : undefined,
      timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined
    });
  }

  if (request.method === "job.status") {
    const params = (request.params && typeof request.params === "object"
      ? request.params
      : {}) as Record<string, unknown>;
    const record = jobManager.getStatus(
      String(params.jobId || ""),
      typeof params.maxLines === "number" ? params.maxLines : undefined
    );
    if (!record) {
      throw new Error(`Job not found: ${String(params.jobId || "")}`);
    }
    return record;
  }

  if (request.method === "job.cancel") {
    const params = (request.params && typeof request.params === "object"
      ? request.params
      : {}) as Record<string, unknown>;
    return jobManager.cancel(String(params.jobId || ""));
  }

  if (request.method === "job.list") {
    return { jobs: jobManager.listJobs(), lastAction: jobManager.getLastAction() };
  }

  if (request.method === "shell.exec") {
    const params = (request.params && typeof request.params === "object"
      ? request.params
      : {}) as Record<string, unknown>;
    return jobManager.executeSync({
      command: String(params.command || ""),
      cwd: typeof params.cwd === "string" ? params.cwd : undefined,
      shell: typeof params.shell === "string" ? params.shell : undefined,
      timeoutMs: typeof params.timeoutMs === "number" ? params.timeoutMs : undefined
    });
  }

  const start = Date.now();
  const params = request.params && typeof request.params === "object"
    ? request.params as Record<string, unknown>
    : {};
  const timeoutMs = typeof params.timeoutMs === "number"
    ? params.timeoutMs
    : 120_000;

  try {
    const result = await workerManager.execute(request.method, request.params, timeoutMs);
    const detail = typeof params.path === "string"
      ? params.path
      : typeof params.command === "string"
        ? params.command
        : typeof params.query === "string"
          ? params.query
          : typeof params.url === "string"
            ? params.url
            : typeof params.selector === "string"
              ? params.selector
              : typeof params.text === "string"
                ? params.text
                : typeof params.key === "string"
                  ? params.key
                  : typeof params.title === "string"
                    ? params.title
                    : "";
    jobManager.recordAction(request.method, detail, Date.now() - start, "completed");
    return result;
  } catch (error) {
    const detail = typeof params.path === "string"
      ? params.path
      : typeof params.command === "string"
        ? params.command
        : typeof params.query === "string"
          ? params.query
          : typeof params.url === "string"
            ? params.url
            : typeof params.selector === "string"
              ? params.selector
              : typeof params.text === "string"
                ? params.text
                : typeof params.key === "string"
                  ? params.key
                  : typeof params.title === "string"
                    ? params.title
                    : "";
    jobManager.recordAction(request.method, detail, Date.now() - start, "failed");
    throw error;
  }
}

async function startHealthServer(): Promise<void> {
  healthServer = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({
        ok: true,
        service: "nomsod-agent-guardian",
        version,
        clusterId,
        guardianPid: process.pid,
        gatewayConnected: connectedGateways.size > 0,
        connectedGateways: connectedGateways.size,
        configuredGateways: gatewayUrls.size,
        worker: workerManager.status().active,
        activeJobs: jobManager.listJobs().filter(j => j.status === "running").length,
        lastAction: jobManager.getLastAction()
      }));
      return;
    }

    if (req.method === "GET" && url.pathname === "/jobs") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({
        ok: true,
        jobs: jobManager.listJobs(),
        lastAction: jobManager.getLastAction()
      }));
      return;
    }

    if (req.method === "POST" && url.pathname === "/jobs/cancel") {
      let body = "";
      for await (const chunk of req) {
        body += chunk;
      }
      try {
        const parsed = JSON.parse(body);
        const jobId = String(parsed.jobId || "");
        const result = jobManager.cancel(jobId);
        res.writeHead(200, {
          "content-type": "application/json; charset=utf-8",
          "cache-control": "no-store"
        });
        res.end(JSON.stringify(result));
      } catch (err: any) {
        res.writeHead(400, {
          "content-type": "application/json; charset=utf-8"
        });
        res.end(JSON.stringify({ ok: false, error: err.message || "Invalid JSON" }));
      }
      return;
    }

    res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "not_found" }));
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      healthServer?.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      healthServer?.off("error", onError);
      resolve();
    };

    healthServer!.once("error", onError);
    healthServer!.once("listening", onListening);
    healthServer!.listen(healthPort, "127.0.0.1");
  });

  console.log(`[agent-guardian] health=http://127.0.0.1:${healthPort}/health`);
}

async function run(): Promise<void> {
  await workerManager.initialize();
  await startHealthServer();

  const identity = await loadIdentity();
  const descriptor = buildDescriptor(identity.deviceId, version);

  console.log(
    `[agent-guardian] device=${descriptor.displayName} id=${descriptor.deviceId} platform=${descriptor.platform}`
  );
  console.log(`[agent-guardian] cluster=${clusterId}`);
  console.log(`[agent-guardian] configured gateways=${gatewayUrls.size}`);

  const saveDeviceToken = async (deviceToken: string) => {
    if (
      identity.deviceToken?.startsWith("ndt2.") &&
      !deviceToken.startsWith("ndt2.")
    ) {
      return;
    }

    identity.deviceToken = deviceToken;
    identityWriteChain = identityWriteChain.then(() => saveIdentity(identity));
    await identityWriteChain;
  };

  function closeFallbackConnections(): void {
    for (const [gatewayUrl, socket] of socketByGatewayUrl) {
      if (!isFallbackGatewayUrl(gatewayUrl)) continue;
      if (socket.readyState !== WebSocket.OPEN && socket.readyState !== WebSocket.CONNECTING) continue;
      if (!shouldParkFallbackGateway(gatewayUrl, connectedGateways, hubIdByGatewayUrl)) continue;
      console.log(`[agent-guardian] parking fallback gateway while a primary route to the same hub is healthy: ${gatewayUrl}`);
      try { socket.close(4007, "primary gateway available"); }
      catch { try { socket.terminate(); } catch {} }
    }
  }

  function ensureFallbackConnections(): void {
    if (stopping) return;
    for (const gatewayUrl of gatewayUrls) {
      if (isFallbackGatewayUrl(gatewayUrl) && !shouldParkFallbackGateway(gatewayUrl, connectedGateways, hubIdByGatewayUrl)) {
        connect(gatewayUrl);
      }
    }
  }

  function scheduleFallbackConnections(delayMs = 1_500): void {
    if (fallbackGatewayTimer) clearTimeout(fallbackGatewayTimer);
    fallbackGatewayTimer = setTimeout(() => ensureFallbackConnections(), delayMs);
    fallbackGatewayTimer.unref();
  }

  const connect = (gatewayUrl: string) => {
    if (stopping || connectingGateways.has(gatewayUrl) || connectedGateways.has(gatewayUrl)) return;
    if (isFallbackGatewayUrl(gatewayUrl) && shouldParkFallbackGateway(gatewayUrl, connectedGateways, hubIdByGatewayUrl)) return;
    connectingGateways.add(gatewayUrl);

    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      lookup: resilientLookup as any
    });
    sockets.add(ws);
    socketByGatewayUrl.set(gatewayUrl, ws);

    let lastInbound = Date.now();
    let heartbeatTimer: NodeJS.Timeout | undefined;
    let staleTimer: NodeJS.Timeout | undefined;

    const send = (message: AgentToGateway) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const cleanupTimers = () => {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (staleTimer) clearInterval(staleTimer);
    };

    ws.on("open", () => {
      connectedGateways.delete(gatewayUrl);
      reconnectAttempts.set(gatewayUrl, 0);
      lastInbound = Date.now();

      // Enable TCP keep-alive on the underlying socket (10s probe interval)
      const netSocket = (ws as any)._socket;
      if (netSocket && typeof netSocket.setKeepAlive === "function") {
        try { netSocket.setKeepAlive(true, 10_000); } catch {}
      }

      send({
        type: "hello",
        device: descriptor,
        deviceToken: identity.deviceToken,
        pairingToken: pairingToken || undefined
      });

      heartbeatTimer = setInterval(
        () => send({ type: "heartbeat", at: Date.now() }),
        heartbeatMs
      );

      staleTimer = setInterval(() => {
        if (Date.now() - lastInbound > staleMs) {
          console.warn(`[agent-guardian] gateway stale ${gatewayUrl}; forcing reconnect`);
          ws.terminate();
        }
      }, Math.max(5_000, Math.floor(heartbeatMs / 2)));
    });

    ws.on("message", async raw => {
      lastInbound = Date.now();

      let message: GatewayToAgent;
      try {
        message = JSON.parse(raw.toString()) as GatewayToAgent;
      } catch {
        return;
      }

      if (message.type === "heartbeat") return;

      if (message.type === "paired") {
        await saveDeviceToken(message.deviceToken);
        console.log(`[agent-guardian] paired via ${gatewayUrl}; persistent device token saved`);
        return;
      }

      if (message.type === "ready") {
        connectingGateways.delete(gatewayUrl);
        connectedGateways.add(gatewayUrl);
        if (message.hubId) {
          hubIdByGatewayUrl.set(gatewayUrl, message.hubId);
        }
        reconnectAttempts.set(gatewayUrl, 0);
        console.log(`[agent-guardian] connected and ready: ${gatewayUrl}${message.hubId ? ` (hub=${message.hubId})` : ""}`);

        if (!isFallbackGatewayUrl(gatewayUrl)) {
          if (fallbackGatewayTimer) {
            clearTimeout(fallbackGatewayTimer);
            fallbackGatewayTimer = undefined;
          }
          closeFallbackConnections();
        }
        return;
      }

      if (message.type === "request") {
        const request = message as AgentRequest;

        try {
          const result = await handleRequest(request);
          send({
            type: "response",
            requestId: request.requestId,
            result
          });
        } catch (error) {
          send({
            type: "response",
            requestId: request.requestId,
            error: {
              message: error instanceof Error ? error.message : String(error)
            }
          });
        }
      }
    });

    ws.on("ping", data => {
      lastInbound = Date.now();
      try { ws.pong(data); } catch {}
    });

    ws.on("error", error => {
      console.warn(`[agent-guardian] websocket error ${gatewayUrl}:`, error.message);
    });

    ws.on("close", (code, reason) => {
      connectingGateways.delete(gatewayUrl);
      connectedGateways.delete(gatewayUrl);
      hubIdByGatewayUrl.delete(gatewayUrl);
      sockets.delete(ws);
      if (socketByGatewayUrl.get(gatewayUrl) === ws) socketByGatewayUrl.delete(gatewayUrl);
      cleanupTimers();
      if (stopping) return;

      scheduleFallbackConnections(250);

      if (isFallbackGatewayUrl(gatewayUrl) && shouldParkFallbackGateway(gatewayUrl, connectedGateways, hubIdByGatewayUrl)) {
        reconnectAttempts.set(gatewayUrl, 0);
        console.log(`[agent-guardian] fallback gateway parked: ${gatewayUrl}`);
        return;
      }

      const attempt = reconnectAttempts.get(gatewayUrl) || 0;
      const delay = backoffMs(attempt);
      reconnectAttempts.set(gatewayUrl, attempt + 1);
      console.warn(
        `[agent-guardian] disconnected ${gatewayUrl} code=${code} reason=${reason.toString() || "-"}; reconnect in ${delay}ms`
      );
      setTimeout(() => connect(gatewayUrl), delay);
    });
  };

  const discoverAndConnectPeers = async () => {
    const livePeerUrls = new Set(discoverTailscaleGatewayUrls());

    // Prune discovered peers that went offline on Tailscale
    for (const peerUrl of discoveredPeerUrls) {
      if (!livePeerUrls.has(peerUrl)) {
        discoveredPeerUrls.delete(peerUrl);
        gatewayUrls.delete(peerUrl);
        reconnectAttempts.delete(peerUrl);
        const ws = socketByGatewayUrl.get(peerUrl);
        if (ws) {
          console.log(`[agent-guardian] peer went offline on Tailscale; closing socket: ${peerUrl}`);
          try { ws.terminate(); } catch {}
        }
      }
    }

    await Promise.all([...livePeerUrls].map(async gatewayUrl => {
      if (gatewayUrls.has(gatewayUrl)) {
        connect(gatewayUrl);
        return;
      }

      if (!(await probeNomsodPeerGateway(gatewayUrl))) return;

      discoveredPeerUrls.add(gatewayUrl);
      gatewayUrls.add(gatewayUrl);
      console.log("[agent-guardian] discovered Nomsod peer gateway: " + gatewayUrl);
      connect(gatewayUrl);
    }));
  };

  // Sleep/wake detection via timer drift
  let lastTick = Date.now();
  const sleepCheckIntervalMs = 2_500;
  sleepDetectorTimer = setInterval(() => {
    const now = Date.now();
    const drift = now - lastTick - sleepCheckIntervalMs;
    lastTick = now;
    if (drift > 5_000) {
      console.warn(`[agent-guardian] detected system sleep/wake pause (${drift}ms); resetting retry backoffs and verifying connections`);
      reconnectAttempts.clear();
      for (const [url, ws] of socketByGatewayUrl) {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.ping(); } catch {}
        } else {
          try { ws.terminate(); } catch {}
        }
      }
      scheduleFallbackConnections(100);
    }
  }, sleepCheckIntervalMs);
  sleepDetectorTimer.unref();

  for (const gatewayUrl of gatewayUrls) {
    if (!isFallbackGatewayUrl(gatewayUrl) || !shouldParkFallbackGateway(gatewayUrl, connectedGateways, hubIdByGatewayUrl)) {
      connect(gatewayUrl);
    }
  }

  scheduleFallbackConnections();
  void discoverAndConnectPeers();
  peerDiscoveryTimer = setInterval(() => void discoverAndConnectPeers(), 30_000);
  peerDiscoveryTimer.unref();
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  connectedGateways.clear();
  connectingGateways.clear();
  hubIdByGatewayUrl.clear();
  discoveredPeerUrls.clear();
  if (sleepDetectorTimer) clearInterval(sleepDetectorTimer);
  if (peerDiscoveryTimer) clearInterval(peerDiscoveryTimer);
  if (fallbackGatewayTimer) clearTimeout(fallbackGatewayTimer);

  for (const ws of sockets) {
    try { ws.close(1001, "agent shutdown"); } catch {}
  }
  sockets.clear();
  socketByGatewayUrl.clear();

  await Promise.all([
    workerManager.shutdown(),
    new Promise<void>(resolve => {
      if (!healthServer) {
        resolve();
        return;
      }
      healthServer.close(() => resolve());
    })
  ]);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown().finally(() => process.exit(0));
  });
}

run().catch(error => {
  console.error("[agent-guardian] fatal:", error);
  process.exitCode = 1;
});
