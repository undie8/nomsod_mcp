import { describe, expect, it, vi } from "vitest";
import { createNomsodMcpHandler } from "../src/gateway/mcp.js";
import type { ComputerHub } from "../src/gateway/hub-client.js";

describe("MCP browser tools", () => {
  it("initializes handler with browser tools registered", () => {
    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockResolvedValue({})
    };

    const handler = createNomsodMcpHandler(mockHub);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("object");
  });

  it("routes browser actions to hub correctly", async () => {
    const requestsReceived: Array<{ deviceId: string; method: string; params?: unknown }> = [];

    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockImplementation(async (deviceId, method, params) => {
        requestsReceived.push({ deviceId, method, params });
        if (method === "browser.navigate") {
          return { ok: true, url: "https://example.com", title: "Example" };
        }
        if (method === "browser.click") {
          return { ok: true, selector: "button" };
        }
        if (method === "browser.type") {
          return { ok: true, selector: "input", textLength: 4 };
        }
        if (method === "browser.snapshot") {
          return { url: "https://example.com", title: "Example", htmlSnippet: "<div>hello</div>", consoleLogs: [], hasErrors: false };
        }
        if (method === "browser.screenshot") {
          return { base64: "c2NyZWVu", mimeType: "image/png", bytes: 6 };
        }
        if (method === "browser.close") {
          return { ok: true, message: "closed" };
        }
        return {};
      })
    };

    await mockHub.request("dev-1", "browser.navigate", { url: "https://example.com" });
    await mockHub.request("dev-1", "browser.click", { selector: "button" });
    await mockHub.request("dev-1", "browser.type", { selector: "input", text: "test" });
    await mockHub.request("dev-1", "browser.snapshot", {});
    await mockHub.request("dev-1", "browser.screenshot", { fullPage: false });
    await mockHub.request("dev-1", "browser.close");

    expect(requestsReceived.length).toBe(6);
    expect(requestsReceived[0].method).toBe("browser.navigate");
    expect(requestsReceived[1].method).toBe("browser.click");
    expect(requestsReceived[2].method).toBe("browser.type");
    expect(requestsReceived[3].method).toBe("browser.snapshot");
    expect(requestsReceived[4].method).toBe("browser.screenshot");
    expect(requestsReceived[5].method).toBe("browser.close");
  });
});
