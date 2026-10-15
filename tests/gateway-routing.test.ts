import { describe, expect, it } from "vitest";
import {
  hasConnectedPrimaryGateway,
  isFallbackGatewayUrl,
  isLoopbackGatewayUrl,
  shouldParkFallbackGateway
} from "../src/agent/gateway-routing.js";

describe("gateway routing", () => {
  it("treats secure public websocket routes as fallback routes", () => {
    expect(isFallbackGatewayUrl("wss://mcp.nomsod.net/agent")).toBe(true);
    expect(isFallbackGatewayUrl("ws://127.0.0.1:34100/agent")).toBe(false);
    expect(isFallbackGatewayUrl("ws://100.91.123.36:34104/agent")).toBe(false);
  });

  it("identifies loopback URLs accurately", () => {
    expect(isLoopbackGatewayUrl("ws://127.0.0.1:34100/agent")).toBe(true);
    expect(isLoopbackGatewayUrl("ws://localhost:34100/agent")).toBe(true);
    expect(isLoopbackGatewayUrl("ws://[::1]:34100/agent")).toBe(true);
    expect(isLoopbackGatewayUrl("ws://100.91.123.36:34104/agent")).toBe(false);
    expect(isLoopbackGatewayUrl("wss://mcp.nomsod.net/agent")).toBe(false);
  });

  it("uses fallback only when no local or peer gateway is connected", () => {
    expect(hasConnectedPrimaryGateway([])).toBe(false);
    expect(hasConnectedPrimaryGateway(["wss://mcp.nomsod.net/agent"])).toBe(false);
    expect(hasConnectedPrimaryGateway(["wss://mcp.nomsod.net/agent", "ws://100.91.123.36:34104/agent"])).toBe(true);
    expect(hasConnectedPrimaryGateway(["ws://127.0.0.1:34100/agent"])).toBe(true);
  });

  it("parks fallback gateway only if connected to the same hub as a primary route", () => {
    const fallbackUrl = "wss://mcp.nomsod.net/agent";
    const localUrl = "ws://127.0.0.1:34100/agent";
    const peerUrl = "ws://100.91.123.36:34104/agent";

    // Scenario A: GUNN connects to local (hub_A) and public fallback (hub_A) -> same hub, park fallback
    const gunnHubMap = new Map([
      [localUrl, "hub_A"],
      [fallbackUrl, "hub_A"]
    ]);
    expect(shouldParkFallbackGateway(fallbackUrl, [localUrl, fallbackUrl], gunnHubMap)).toBe(true);

    // Scenario B: MacBook connects to its local (hub_B) and public fallback (hub_A on GUNN) -> different hubs, DO NOT park!
    const macHubMap = new Map([
      [localUrl, "hub_B"],
      [fallbackUrl, "hub_A"]
    ]);
    expect(shouldParkFallbackGateway(fallbackUrl, [localUrl, fallbackUrl], macHubMap)).toBe(false);

    // Scenario C: MacBook connects to Tailscale peer (hub_A on GUNN) and public fallback (hub_A on GUNN) -> same hub, park fallback!
    const macWithPeerMap = new Map([
      [localUrl, "hub_B"],
      [peerUrl, "hub_A"],
      [fallbackUrl, "hub_A"]
    ]);
    expect(shouldParkFallbackGateway(fallbackUrl, [localUrl, peerUrl, fallbackUrl], macWithPeerMap)).toBe(true);
  });
});
