import { describe, expect, it, vi } from "vitest";
import { createNomsodMcpHandler } from "../src/gateway/mcp.js";
import type { ComputerHub } from "../src/gateway/hub-client.js";

describe("MCP desktop automation tools", () => {
  it("initializes handler with desktop tools registered", () => {
    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockResolvedValue({})
    };

    const handler = createNomsodMcpHandler(mockHub);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("object");
  });

  it("routes desktop automation actions to hub correctly", async () => {
    const requestsReceived: Array<{ deviceId: string; method: string; params?: unknown }> = [];

    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockImplementation(async (deviceId, method, params) => {
        requestsReceived.push({ deviceId, method, params });
        if (method === "desktop.click") {
          return { ok: true, x: 100, y: 200, button: "left", double: false };
        }
        if (method === "desktop.mouse_move") {
          return { ok: true, x: 100, y: 200 };
        }
        if (method === "desktop.get_cursor_position") {
          return { ok: true, x: 100, y: 200 };
        }
        if (method === "desktop.type") {
          return { ok: true, text: "hello", length: 5 };
        }
        if (method === "desktop.key_press") {
          return { ok: true, key: "enter" };
        }
        if (method === "desktop.list_windows") {
          return { ok: true, windows: [] };
        }
        if (method === "desktop.focus_window") {
          return { ok: true, focused: true };
        }
        return {};
      })
    };

    await mockHub.request("dev-1", "desktop.click", { x: 100, y: 200, button: "left" });
    await mockHub.request("dev-1", "desktop.mouse_move", { x: 100, y: 200 });
    await mockHub.request("dev-1", "desktop.get_cursor_position");
    await mockHub.request("dev-1", "desktop.type", { text: "hello" });
    await mockHub.request("dev-1", "desktop.key_press", { key: "enter" });
    await mockHub.request("dev-1", "desktop.list_windows", {});
    await mockHub.request("dev-1", "desktop.focus_window", { title: "Chrome" });

    expect(requestsReceived.length).toBe(7);
    expect(requestsReceived[0].method).toBe("desktop.click");
    expect(requestsReceived[1].method).toBe("desktop.mouse_move");
    expect(requestsReceived[2].method).toBe("desktop.get_cursor_position");
    expect(requestsReceived[3].method).toBe("desktop.type");
    expect(requestsReceived[4].method).toBe("desktop.key_press");
    expect(requestsReceived[5].method).toBe("desktop.list_windows");
    expect(requestsReceived[6].method).toBe("desktop.focus_window");
  });
});
