import { promises as fs } from "node:fs";
import path from "node:path";
import { resolveClusterKey, signClusterToken, verifyClusterToken } from "../shared/cluster-token.js";

export type EnrollmentPlatform = "windows" | "macos" | "any";

interface EnrollmentInvitePayload {
  purpose: "bootstrap";
  platform: EnrollmentPlatform;
  role: "both";
}

export interface EnrollmentBootstrap {
  version: 1;
  role: "both";
  publicBaseUrl: string;
  gatewayPort: number;
  peerPort: number;
  pairingToken: string;
  ownerKey: string;
  clusterKey: string;
  cloudflare?: {
    tunnelId: string;
    credentialsBase64: string;
    healthUrl: string;
  };
}

export class EnrollmentService {
  private readonly clusterKey = resolveClusterKey();

  constructor(
    private readonly root: string,
    private readonly publicBaseUrl: string,
    private readonly pairingToken: string,
    private readonly ownerKey: string,
    private readonly gatewayPort: number,
    private readonly peerPort: number
  ) {}

  createInvite(platform: EnrollmentPlatform, ttlSeconds = 600): {
    token: string;
    expiresIn: number;
    platform: EnrollmentPlatform;
    windowsCommand: string;
    macosCommand: string;
  } {
    if (!this.clusterKey) {
      throw new Error("Cluster key is unavailable; configure NOMSOD_PAIRING_TOKEN or NOMSOD_CLUSTER_KEY.");
    }

    const expiresIn = Math.max(60, Math.min(3600, Math.floor(ttlSeconds)));
    const token = signClusterToken<EnrollmentInvitePayload>(
      "nen1",
      { purpose: "bootstrap", platform, role: "both" },
      this.clusterKey,
      expiresIn
    );

    const quotedPs = token.replace(/'/g, "''");
    const quotedSh = token.replace(/'/g, "'\"'\"'");
    const publicPs = this.publicBaseUrl.replace(/'/g, "''");
    const publicSh = this.publicBaseUrl.replace(/'/g, "'\"'\"'");

    return {
      token,
      expiresIn,
      platform,
      windowsCommand:
        "$env:NOMSOD_ENROLLMENT_TOKEN='" + quotedPs +
        "'; $env:NOMSOD_PUBLIC_BASE_URL='" + publicPs +
        "'; irm " + this.publicBaseUrl + "/install/windows.ps1 | iex",
      macosCommand:
        "curl -fsSL " + this.publicBaseUrl +
        "/install/macos.sh | NOMSOD_ENROLLMENT_TOKEN='" + quotedSh +
        "' NOMSOD_PUBLIC_BASE_URL='" + publicSh + "' sh"
    };
  }

  async bootstrap(token: string, requestedPlatform?: string): Promise<EnrollmentBootstrap | undefined> {
    if (!this.clusterKey) return undefined;

    const invite = verifyClusterToken<EnrollmentInvitePayload>(token, "nen1", this.clusterKey);
    if (!invite || invite.purpose !== "bootstrap" || invite.role !== "both") return undefined;

    if (
      requestedPlatform &&
      invite.platform !== "any" &&
      invite.platform !== requestedPlatform
    ) {
      return undefined;
    }

    const bundle: EnrollmentBootstrap = {
      version: 1,
      role: "both",
      publicBaseUrl: this.publicBaseUrl,
      gatewayPort: this.gatewayPort,
      peerPort: this.peerPort,
      pairingToken: this.pairingToken,
      ownerKey: this.ownerKey,
      clusterKey: this.clusterKey
    };

    const tunnelId = (process.env.NOMSOD_TUNNEL_ID || "").trim();
    const credentialsPath = (process.env.NOMSOD_TUNNEL_CREDENTIALS || "").trim();
    const healthUrl = (process.env.NOMSOD_TUNNEL_HEALTH_URL || (this.publicBaseUrl + "/health")).trim();

    if (tunnelId && credentialsPath) {
      try {
        const resolved = path.isAbsolute(credentialsPath)
          ? credentialsPath
          : path.resolve(this.root, credentialsPath);
        const bytes = await fs.readFile(resolved);
        bundle.cloudflare = {
          tunnelId,
          credentialsBase64: bytes.toString("base64"),
          healthUrl
        };
      } catch {
        // A node can still enroll as Gateway+Agent even if it cannot provision
        // the public tunnel connector. Another active connector remains usable.
      }
    }

    return bundle;
  }
}
