import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DeviceDescriptor } from "./protocol.js";

export interface StoredIdentity {
  deviceId: string;
  deviceToken?: string;
}

export function identityPath(): string {
  const overridden = process.env.NOMSOD_IDENTITY_PATH?.trim();
  return overridden || path.join(os.homedir(), ".nomsod-mcp", "device.json");
}

export async function loadIdentity(): Promise<StoredIdentity> {
  const file = identityPath();
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as StoredIdentity;
    if (typeof parsed.deviceId === "string" && parsed.deviceId.length > 0) return parsed;
  } catch {}
  const identity: StoredIdentity = { deviceId: "device_" + randomUUID() };
  await saveIdentity(identity);
  return identity;
}

export async function saveIdentity(identity: StoredIdentity): Promise<void> {
  const file = identityPath();
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(identity, null, 2), { encoding: "utf8", mode: 0o600 });
  try { await fs.chmod(file, 0o600); } catch {}
}

export function buildDescriptor(deviceId: string): DeviceDescriptor {
  const hostname = os.hostname();
  const displayName = (process.env.NOMSOD_DEVICE_NAME || hostname).trim() || hostname;
  return {
    deviceId,
    displayName,
    hostname,
    platform: process.platform,
    arch: process.arch,
    version: "0.1.0",
    capabilities: [
      "system.info",
      "fs.list",
      "fs.read",
      "fs.read_range",
      "fs.patch",
      "fs.write",
      "shell.exec",
      "text.utf8-strict",
      "connection.auto-reconnect"
    ]
  };
}
