import { describe, expect, it } from "vitest";
import { signClusterToken, verifyClusterToken } from "../src/shared/cluster-token.js";

describe("cluster tokens", () => {
  it("verifies across nodes that share a cluster key", () => {
    const key = "cluster-test-key-a";
    const token = signClusterToken("nma2", { deviceId: "device-1", scope: "mcp" }, key, 60);

    expect(
      verifyClusterToken<{ deviceId: string; scope: string }>(token, "nma2", key)
    ).toEqual({ deviceId: "device-1", scope: "mcp" });
  });

  it("rejects a different cluster key", () => {
    const token = signClusterToken("ndt2", { deviceId: "device-1" }, "cluster-a");

    expect(
      verifyClusterToken<{ deviceId: string }>(token, "ndt2", "cluster-b")
    ).toBeUndefined();
  });

  it("rejects the wrong token purpose", () => {
    const key = "cluster-a";
    const token = signClusterToken("ndt2", { deviceId: "device-1" }, key);

    expect(
      verifyClusterToken<{ deviceId: string }>(token, "nma2", key)
    ).toBeUndefined();
  });
});
