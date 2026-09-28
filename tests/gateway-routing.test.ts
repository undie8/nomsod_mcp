import { describe, expect, it } from "vitest";
import { hasConnectedPrimaryGateway, isFallbackGatewayUrl } from "../src/agent/gateway-routing.js";

describe("gateway routing", () => {
  it("treats secure public websocket routes as fallback routes", () => {
    expect(isFallbackGatewayUrl("wss://mcp.nomsod.net/agent")).toBe(true);
    expect(isFallbackGatewayUrl("ws://127.0.0.1:34100/agent")).toBe(false);
    expect(isFallbackGatewayUrl("ws://100.91.123.36:34104/agent")).toBe(false);
  });

  it("uses fallback only when no local or peer gateway is connected", () => {
    expect(hasConnectedPrimaryGateway([])).toBe(false);
    expect(hasConnectedPrimaryGateway(["wss://mcp.nomsod.net/agent"])).toBe(false);
    expect(hasConnectedPrimaryGateway(["wss://mcp.nomsod.net/agent", "ws://100.91.123.36:34104/agent"])).toBe(true);
    expect(hasConnectedPrimaryGateway(["ws://127.0.0.1:34100/agent"])).toBe(true);
  });
});
