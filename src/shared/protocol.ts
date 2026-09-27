export type DevicePlatform = "win32" | "darwin" | "linux" | string;

export interface DeviceDescriptor {
  deviceId: string;
  displayName: string;
  hostname: string;
  platform: DevicePlatform;
  arch: string;
  version: string;
  capabilities: string[];
}

export type AgentHello = {
  type: "hello";
  device: DeviceDescriptor;
  deviceToken?: string;
  pairingToken?: string;
};

export type GatewayPaired = {
  type: "paired";
  deviceId: string;
  deviceToken: string;
};

export type GatewayReady = {
  type: "ready";
  deviceId: string;
};

export type Heartbeat = {
  type: "heartbeat";
  at: number;
};

export type AgentRequest = {
  type: "request";
  requestId: string;
  method: string;
  params?: unknown;
};

export type AgentResponse = {
  type: "response";
  requestId: string;
  result?: unknown;
  error?: { message: string; code?: string };
};

export type AgentToGateway = AgentHello | Heartbeat | AgentResponse;
export type GatewayToAgent = GatewayPaired | GatewayReady | Heartbeat | AgentRequest;
