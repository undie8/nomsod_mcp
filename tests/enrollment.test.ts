import { afterEach, describe, expect, it } from "vitest";
import { EnrollmentService } from "../src/supervisor/enrollment.js";

const original = {
  cluster: process.env.NOMSOD_CLUSTER_KEY,
  pairing: process.env.NOMSOD_PAIRING_TOKEN,
  tunnelId: process.env.NOMSOD_TUNNEL_ID,
  tunnelCreds: process.env.NOMSOD_TUNNEL_CREDENTIALS
};

afterEach(() => {
  if (original.cluster === undefined) delete process.env.NOMSOD_CLUSTER_KEY;
  else process.env.NOMSOD_CLUSTER_KEY = original.cluster;
  if (original.pairing === undefined) delete process.env.NOMSOD_PAIRING_TOKEN;
  else process.env.NOMSOD_PAIRING_TOKEN = original.pairing;
  if (original.tunnelId === undefined) delete process.env.NOMSOD_TUNNEL_ID;
  else process.env.NOMSOD_TUNNEL_ID = original.tunnelId;
  if (original.tunnelCreds === undefined) delete process.env.NOMSOD_TUNNEL_CREDENTIALS;
  else process.env.NOMSOD_TUNNEL_CREDENTIALS = original.tunnelCreds;
});

function service() {
  process.env.NOMSOD_CLUSTER_KEY = "test-cluster-key";
  process.env.NOMSOD_PAIRING_TOKEN = "test-pairing";
  delete process.env.NOMSOD_TUNNEL_ID;
  delete process.env.NOMSOD_TUNNEL_CREDENTIALS;

  return new EnrollmentService(
    process.cwd(),
    "https://mcp.nomsod.net",
    "test-pairing",
    "test-owner",
    "nomsod-main-v1",
    34100,
    34104
  );
}

describe("enrollment", () => {
  it("creates a short-lived invite and returns a bootstrap bundle", async () => {
    const enrollment = service();
    const invite = enrollment.createInvite("windows", 600);

    expect(invite.windowsCommand).toContain("NOMSOD_ENROLLMENT_TOKEN");
    expect(invite.windowsCommand).toContain("/install/windows.ps1");
    expect(invite.windowsCommand).toContain("NOMSOD_PUBLIC_BASE_URL");
    expect(invite.windowsCommand).toContain("NOMSOD_CLUSTER_ID");
    expect(invite.macosCommand).toContain("NOMSOD_PUBLIC_BASE_URL");
    expect(invite.macosCommand).toContain("NOMSOD_CLUSTER_ID");
    expect(invite.token.startsWith("nen1.")).toBe(true);

    const bundle = await enrollment.bootstrap(invite.token, "windows");
    expect(bundle).toMatchObject({
      version: 2,
      role: "both",
      clusterId: "nomsod-main-v1",
      publicBaseUrl: "https://mcp.nomsod.net",
      gatewayPort: 34100,
      peerPort: 34104,
      pairingToken: "test-pairing",
      ownerKey: "test-owner",
      clusterKey: "test-cluster-key"
    });
  });

  it("rejects an invite for the wrong platform", async () => {
    const enrollment = service();
    const invite = enrollment.createInvite("windows", 600);
    expect(await enrollment.bootstrap(invite.token, "macos")).toBeUndefined();
  });

  it("rejects a tampered invite", async () => {
    const enrollment = service();
    const invite = enrollment.createInvite("any", 600);
    const tampered = invite.token.slice(0, -1) + (invite.token.endsWith("A") ? "B" : "A");
    expect(await enrollment.bootstrap(tampered, "windows")).toBeUndefined();
  });
});
