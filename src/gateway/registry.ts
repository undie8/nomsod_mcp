import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveClusterKey, signClusterToken, verifyClusterToken } from "../shared/cluster-token.js";
import type { DeviceDescriptor } from "../shared/protocol.js";

export interface DeviceRecord {
  deviceId: string;
  tokenHash: string;
  firstPairedAt: string;
  lastSeenAt: string;
  lastDescriptor: DeviceDescriptor;
}

interface RegistryFile {
  devices: Record<string, DeviceRecord>;
}

interface ClusterDevicePayload {
  deviceId: string;
}

export class DeviceRegistry {
  private data: RegistryFile = { devices: {} };
  private loaded = false;

  constructor(
    private readonly file = path.resolve("data", "devices.json"),
    private readonly clusterKey = resolveClusterKey()
  ) {}

  private hash(token: string): string {
    return createHash("sha256").update(token).digest("hex");
  }

  async load(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;
    try {
      this.data = JSON.parse(await fs.readFile(this.file, "utf8")) as RegistryFile;
      this.data.devices ||= {};
    } catch {
      this.data = { devices: {} };
    }
  }

  private async persist(): Promise<void> {
    await fs.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = this.file + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await fs.rename(tmp, this.file);
  }

  async pair(device: DeviceDescriptor): Promise<string> {
    await this.load();
    const token = this.clusterKey
      ? signClusterToken("ndt2", { deviceId: device.deviceId }, this.clusterKey)
      : "ndt_" + randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    this.data.devices[device.deviceId] = {
      deviceId: device.deviceId,
      tokenHash: this.hash(token),
      firstPairedAt: this.data.devices[device.deviceId]?.firstPairedAt ?? now,
      lastSeenAt: now,
      lastDescriptor: device
    };
    await this.persist();
    return token;
  }

  async verify(deviceId: string, token: string): Promise<boolean> {
    await this.load();
    if (this.clusterKey && token.startsWith("ndt2.")) {
      const payload = verifyClusterToken<{ deviceId: string }>(token, "ndt2", this.clusterKey);
      return payload?.deviceId === deviceId;
    }
    const record = this.data.devices[deviceId];
    return !!record && record.tokenHash === this.hash(token);
  }

  async seen(device: DeviceDescriptor): Promise<void> {
    await this.load();
    const now = new Date().toISOString();
    const record = this.data.devices[device.deviceId];
    if (record) {
      record.lastSeenAt = now;
      record.lastDescriptor = device;
    } else {
      this.data.devices[device.deviceId] = {
        deviceId: device.deviceId,
        tokenHash: "cluster",
        firstPairedAt: now,
        lastSeenAt: now,
        lastDescriptor: device
      };
    }
    await this.persist();
  }
}
