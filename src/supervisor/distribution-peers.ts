import { execFileSync } from "node:child_process";
import http from "node:http";

function tailscaleCliCandidates(): string[] {
  const configured = (process.env.NOMSOD_TAILSCALE_CLI || "").trim();
  const candidates = process.platform === "win32"
    ? [
        configured,
        "C:\\Program Files\\Tailscale\\tailscale.exe",
        "C:\\Program Files (x86)\\Tailscale\\tailscale.exe",
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

function discoverTailscalePeerAddresses(): string[] {
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

      const addresses: string[] = [];
      for (const peer of Object.values(status.Peer || {})) {
        if (peer.Online !== true) continue;
        const address = (peer.TailscaleIPs || []).find(value => /^100\./.test(value));
        if (address) addresses.push(address);
      }
      return [...new Set(addresses)];
    } catch {
      continue;
    }
  }

  return [];
}

async function isClusterPeer(base: string, clusterId: string): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get(base + "/health", { timeout: 900 }, res => {
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
            body?.clusterId === clusterId
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

export function createDistributionPeerResolver(
  peerPort: number,
  clusterId: string,
  cacheMs = 5_000
): () => Promise<string[]> {
  let cached: string[] = [];
  let validUntil = 0;
  let refreshing: Promise<string[]> | undefined;

  return async () => {
    if (Date.now() < validUntil) return cached;
    if (refreshing) return refreshing;

    refreshing = (async () => {
      const bases = discoverTailscalePeerAddresses().map(
        address => "http://" + address + ":" + peerPort
      );

      const checks = await Promise.all(
        bases.map(async base => ((await isClusterPeer(base, clusterId)) ? base : undefined))
      );

      cached = checks.filter((value): value is string => !!value);
      validUntil = Date.now() + cacheMs;
      return cached;
    })().finally(() => {
      refreshing = undefined;
    });

    return refreshing;
  };
}
