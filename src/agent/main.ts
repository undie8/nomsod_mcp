import dns from "node:dns";
import http from "node:http";
import path from "node:path";
import WebSocket from "ws";
import { buildDescriptor, loadIdentity, saveIdentity } from "../shared/identity.js";
import type { AgentRequest, AgentToGateway, GatewayToAgent } from "../shared/protocol.js";
import { AgentWorkerManager } from "./worker-manager.js";

const root = process.cwd();
const gatewayUrl = process.env.NOMSOD_GATEWAY_WS || "ws://127.0.0.1:3219/agent";
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
let reconnectAttempt = 0;
let gatewayConnected = false;
let healthServer: http.Server | undefined;

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
        version: "0.1.0",
        guardianPid: process.pid,
        gatewayConnected,
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
  const descriptor = buildDescriptor(identity.deviceId);

  console.log(
    `[agent-guardian] device=${descriptor.displayName} id=${descriptor.deviceId} platform=${descriptor.platform}`
  );

  const connect = () => {
    if (stopping) return;

    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false,
      lookup: resilientLookup as any
    });

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
      gatewayConnected = false;
      reconnectAttempt = 0;
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
          console.warn("[agent-guardian] gateway heartbeat stale; forcing reconnect");
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
        identity.deviceToken = message.deviceToken;
        await saveIdentity(identity);
        console.log("[agent-guardian] paired; persistent device token saved");
        return;
      }

      if (message.type === "ready") {
        gatewayConnected = true;
        console.log("[agent-guardian] connected and ready");
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
      console.warn("[agent-guardian] websocket error:", error.message);
    });

    ws.on("close", (code, reason) => {
      gatewayConnected = false;
      cleanupTimers();
      if (stopping) return;

      const delay = backoffMs(reconnectAttempt++);
      console.warn(
        `[agent-guardian] disconnected code=${code} reason=${reason.toString() || "-"}; reconnect in ${delay}ms`
      );
      setTimeout(connect, delay);
    });
  };

  connect();
}

async function shutdown(): Promise<void> {
  if (stopping) return;
  stopping = true;
  gatewayConnected = false;

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
