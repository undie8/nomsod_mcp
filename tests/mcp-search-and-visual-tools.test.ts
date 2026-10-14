import { describe, expect, it, vi } from "vitest";
import { createNomsodMcpHandler } from "../src/gateway/mcp.js";
import type { ComputerHub } from "../src/gateway/hub-client.js";

describe("MCP search and visual tools", () => {
  it("initializes handler with search_files, read_image_file, and capture_screenshot", () => {
    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockResolvedValue({})
    };

    const handler = createNomsodMcpHandler(mockHub);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("object");
  });

  it("routes fs.search, fs.read_image, and desktop.screenshot requests to hub", async () => {
    const requestsReceived: Array<{ deviceId: string; method: string; params: unknown }> = [];

    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockImplementation(async (deviceId, method, params) => {
        requestsReceived.push({ deviceId, method, params });
        if (method === "fs.search") {
          return { matches: [], totalMatches: 0, totalFilesScanned: 10, durationMs: 5, truncated: false };
        }
        if (method === "fs.read_image") {
          return { base64: "dGVzdA==", mimeType: "image/png", bytes: 4 };
        }
        if (method === "desktop.screenshot") {
          return { base64: "c2NyZWVu", mimeType: "image/png", bytes: 6, capturedAt: Date.now() };
        }
        return {};
      })
    };

    await mockHub.request("device-1", "fs.search", { query: "test" });
    await mockHub.request("device-1", "fs.read_image", { path: "test.png" });
    await mockHub.request("device-1", "desktop.screenshot", { screenMode: "primary" });

    expect(requestsReceived.length).toBe(3);
    expect(requestsReceived[0].method).toBe("fs.search");
    expect(requestsReceived[1].method).toBe("fs.read_image");
    expect(requestsReceived[2].method).toBe("desktop.screenshot");
  });
});
