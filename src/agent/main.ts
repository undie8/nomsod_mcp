import WebSocket from "ws";
import { buildDescriptor, loadIdentity, saveIdentity } from "../shared/identity.js";
import type { AgentRequest, AgentToGateway, GatewayToAgent } from "../shared/protocol.js";
import { executeAction } from "./actions.js";

const gatewayUrl = process.env.NOMSOD_GATEWAY_WS || "ws://127.0.0.1:3219/agent";
const pairingToken = process.env.NOMSOD_PAIRING_TOKEN || "";
const heartbeatMs = Number(process.env.NOMSOD_HEARTBEAT_MS || 15_000);
const staleMs = Number(process.env.NOMSOD_STALE_MS || 45_000);

let stopping = false;
let reconnectAttempt = 0;

function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  const jitter = Math.floor(Math.random() * Math.max(250, base * 0.25));
  return base + jitter;
}

async function run(): Promise<void> {
  const identity = await loadIdentity();
  const descriptor = buildDescriptor(identity.deviceId);

  console.log(`[agent] device=${descriptor.displayName} id=${descriptor.deviceId} platform=${descriptor.platform}`);

  const connect = () => {
    if (stopping) return;

    const ws = new WebSocket(gatewayUrl, {
      handshakeTimeout: 15_000,
      perMessageDeflate: false
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
      reconnectAttempt = 0;
      lastInbound = Date.now();
      send({
        type: "hello",
        device: descriptor,
        deviceToken: identity.deviceToken,
        pairingToken: identity.deviceToken ? undefined : pairingToken
      });

      heartbeatTimer = setInterval(() => send({ type: "heartbeat", at: Date.now() }), heartbeatMs);
      staleTimer = setInterval(() => {
        if (Date.now() - lastInbound > staleMs) {
          console.warn("[agent] gateway heartbeat stale; forcing reconnect");
          ws.terminate();
        }
      }, Math.max(5_000, Math.floor(heartbeatMs / 2)));
    });

    ws.on("message", async raw => {
      lastInbound = Date.now();
      let message: GatewayToAgent;
      try { message = JSON.parse(raw.toString()) as GatewayToAgent; }
      catch { return; }

      if (message.type === "heartbeat") return;

      if (message.type === "paired") {
        identity.deviceToken = message.deviceToken;
        await saveIdentity(identity);
        console.log("[agent] paired; persistent device token saved");
        return;
      }

      if (message.type === "ready") {
        console.log("[agent] connected and ready");
        return;
      }

      if (message.type === "request") {
        const request = message as AgentRequest;
        try {
          const result = await executeAction(request.method, request.params);
          send({ type: "response", requestId: request.requestId, result });
        } catch (error) {
          send({
            type: "response",
            requestId: request.requestId,
            error: { message: error instanceof Error ? error.message : String(error) }
          });
        }
      }
    });

    ws.on("ping", data => {
      lastInbound = Date.now();
      try { ws.pong(data); } catch {}
    });

    ws.on("error", error => {
      console.warn("[agent] websocket error:", error.message);
    });

    ws.on("close", (code, reason) => {
      cleanupTimers();
      if (stopping) return;
      const delay = backoffMs(reconnectAttempt++);
      console.warn(`[agent] disconnected code=${code} reason=${reason.toString() || "-"}; reconnect in ${delay}ms`);
      setTimeout(connect, delay);
    });
  };

  connect();
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping = true;
    process.exit(0);
  });
}

run().catch(error => {
  console.error("[agent] fatal:", error);
  process.exitCode = 1;
});
