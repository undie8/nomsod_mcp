import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AgentHello, AgentResponse, DeviceDescriptor, GatewayToAgent } from "../shared/protocol.js";
import { DeviceRegistry } from "./registry.js";

interface ConnectedDevice {
  descriptor: DeviceDescriptor;
  ws: WebSocket;
  connectedAt: number;
  lastSeen: number;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason?: unknown) => void;
  timer: NodeJS.Timeout;
  deviceId: string;
}

export class AgentHub {
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  private readonly devices = new Map<string, ConnectedDevice>();
  private readonly pending = new Map<string, PendingRequest>();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(
    private readonly registry: DeviceRegistry,
    private readonly pairingToken: string,
    private readonly requestTimeoutMs = 120_000
  ) {
    this.wss.on("connection", ws => this.onConnection(ws));
    this.heartbeatTimer = setInterval(() => this.sweep(), 15_000);
    this.heartbeatTimer.unref();
  }

  handleUpgrade(req: IncomingMessage, socket: import("node:stream").Duplex, head: Buffer): void {
    this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit("connection", ws, req));
  }

  listDevices() {
    return [...this.devices.values()].map(item => ({
      ...item.descriptor,
      online: item.ws.readyState === WebSocket.OPEN,
      connectedAt: new Date(item.connectedAt).toISOString(),
      lastSeenAt: new Date(item.lastSeen).toISOString()
    }));
  }

  async request(deviceId: string, method: string, params?: unknown, timeoutMs = this.requestTimeoutMs): Promise<unknown> {
    const device = this.devices.get(deviceId);
    if (!device || device.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`Device is offline or unknown: ${deviceId}`);
    }

    const requestId = randomUUID();
    const message: GatewayToAgent = { type: "request", requestId, method, params };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Agent request timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pending.set(requestId, { resolve, reject, timer, deviceId });
      try {
        device.ws.send(JSON.stringify(message));
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(requestId);
        reject(error);
      }
    });
  }

  private onConnection(ws: WebSocket): void {
    let authenticatedDeviceId: string | undefined;
    let helloDeadline: NodeJS.Timeout | undefined = setTimeout(() => ws.close(4001, "hello timeout"), 10_000);

    ws.on("message", async raw => {
      let message: any;
      try { message = JSON.parse(raw.toString()); }
      catch { ws.close(4002, "invalid json"); return; }

      if (!authenticatedDeviceId) {
        if (message?.type !== "hello") {
          ws.close(4003, "hello required");
          return;
        }

        const hello = message as AgentHello;
        const device = hello.device;
        if (!device?.deviceId || !device?.displayName || !device?.platform) {
          ws.close(4004, "invalid device descriptor");
          return;
        }

        let accepted = false;
        if (hello.deviceToken) {
          accepted = await this.registry.verify(device.deviceId, hello.deviceToken);
        } else if (this.pairingToken && hello.pairingToken === this.pairingToken) {
          const token = await this.registry.pair(device);
          ws.send(JSON.stringify({ type: "paired", deviceId: device.deviceId, deviceToken: token }));
          accepted = true;
        }

        if (!accepted) {
          ws.close(4005, "authentication failed");
          return;
        }

        authenticatedDeviceId = device.deviceId;
        if (helloDeadline) clearTimeout(helloDeadline);
        helloDeadline = undefined;

        const old = this.devices.get(device.deviceId);
        if (old && old.ws !== ws) old.ws.close(4000, "superseded by reconnect");

        this.devices.set(device.deviceId, {
          descriptor: device,
          ws,
          connectedAt: Date.now(),
          lastSeen: Date.now()
        });
        await this.registry.seen(device);
        ws.send(JSON.stringify({ type: "ready", deviceId: device.deviceId }));
        return;
      }

      const connected = this.devices.get(authenticatedDeviceId);
      if (connected?.ws === ws) connected.lastSeen = Date.now();

      if (message?.type === "heartbeat") {
        ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
        return;
      }

      if (message?.type === "response") {
        const response = message as AgentResponse;
        const pending = this.pending.get(response.requestId);
        if (!pending || pending.deviceId !== authenticatedDeviceId) return;
        clearTimeout(pending.timer);
        this.pending.delete(response.requestId);
        if (response.error) pending.reject(new Error(response.error.message));
        else pending.resolve(response.result);
      }
    });

    ws.on("pong", () => {
      if (!authenticatedDeviceId) return;
      const connected = this.devices.get(authenticatedDeviceId);
      if (connected?.ws === ws) connected.lastSeen = Date.now();
    });

    ws.on("close", () => {
      if (helloDeadline) clearTimeout(helloDeadline);
      if (!authenticatedDeviceId) return;

      const connected = this.devices.get(authenticatedDeviceId);
      if (connected?.ws === ws) this.devices.delete(authenticatedDeviceId);

      for (const [requestId, pending] of this.pending) {
        if (pending.deviceId !== authenticatedDeviceId) continue;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.reject(new Error(`Device disconnected during request: ${authenticatedDeviceId}`));
      }
    });
  }

  private sweep(): void {
    const now = Date.now();
    for (const [deviceId, device] of this.devices) {
      if (device.ws.readyState !== WebSocket.OPEN) continue;
      if (now - device.lastSeen > 45_000) {
        device.ws.terminate();
        this.devices.delete(deviceId);
        continue;
      }
      try { device.ws.ping(); } catch {}
    }
  }
}
