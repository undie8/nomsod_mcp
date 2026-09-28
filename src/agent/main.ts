import { execFileSync } from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import { URL } from "node:url";
import WebSocket from "ws";
import { buildDescriptor, loadIdentity, saveIdentity } from "../shared/identity.js";
import type { AgentRequest, AgentToGateway, GatewayToAgent } from "../shared/protocol.js";
import { getNomsodVersion } from "../shared/version.js";
import { AgentWorkerManager } from "./worker-manager.js";

const root = process.cwd();
const version = getNomsodVersion(root);
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
const reconnectAttempts = new Map<string, number>();
const connectingGateways = new Set<string>();
let peerDiscoveryTimer: NodeJS.Timeout | undefined;
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
          resolve(body?.ok === true && body?.service === "nomsod-peer");
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

  const params = request.params && typeof request.params === "object"
    ? request.params as Record<string, unknown>
    : {};
  const timeoutMs = typeof params.timeoutMs === "number"
    ? params.timeoutMs
    : 120_000;

  return workerManager.execute(request.method, request.params, timeoutMs);
}

async function startHealthServer(): Promise<void> {
  healthServer = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({
        ok: true,
        service: "nomsod-agent-guardian",
        version,
        guardianPid: process.pid,
        gatewayConnected: connectedGateways.size > 0,
        connectedGateways: connectedGateways.size,
        configuredGateways: gatewayUrls.size,
        worker: workerManager.status().active
      }));
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

  const connect = (gatewayUrl: string) => {
    if (stopping || connectingGateways.has(gatewayUrl) || connectedGateways.has(gatewayUrl)) return;
    connectingGateways.add(gatewayUrl);

    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      lookup: resilientLookup as any
    });
    sockets.add(ws);

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
        console.log(`[agent-guardian] connected and ready: ${gatewayUrl}`);
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
      sockets.delete(ws);
      cleanupTimers();
      if (stopping) return;

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
    await Promise.all(discoverTailscaleGatewayUrls().map(async gatewayUrl => {
      if (gatewayUrls.has(gatewayUrl)) {
        connect(gatewayUrl);
        return;
      }

      if (!(await probeNomsodPeerGateway(gatewayUrl))) return;

      gatewayUrls.add(gatewayUrl);
      console.log("[agent-guardian] discovered Nomsod peer gateway: " + gatewayUrl);
      connect(gatewayUrl);
    }));
  };

  for (const gatewayUrl of gatewayUrls) {
    connect(gatewayUrl);
  }

  void discoverAndConnectPeers();
  peerDiscoveryTimer = setInterval(() => void discoverAndConnectPeers(), 30_000);
  peerDiscoveryTimer.unref();
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  connectedGateways.clear();
  connectingGateways.clear();
  if (peerDiscoveryTimer) clearInterval(peerDiscoveryTimer);

  for (const ws of sockets) {
    try { ws.close(1001, "agent shutdown"); } catch {}
  }
  sockets.clear();

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
