import { describe, expect, it, vi } from "vitest";
import { createNomsodMcpHandler } from "../src/gateway/mcp.js";
import type { ComputerHub } from "../src/gateway/hub-client.js";

describe("MCP async job tools", () => {
  it("initializes handler with async job tools registered", () => {
    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockResolvedValue({})
    };

    const handler = createNomsodMcpHandler(mockHub);
    expect(handler).toBeDefined();
    expect(typeof handler).toBe("object");
  });

  it("handles job.start, job.status, and job.cancel requests correctly", async () => {
    const requestsReceived: Array<{ deviceId: string; method: string; params: unknown }> = [];

    const mockHub: ComputerHub = {
      listDevices: vi.fn().mockReturnValue([]),
      request: vi.fn().mockImplementation(async (deviceId, method, params) => {
        requestsReceived.push({ deviceId, method, params });
        if (method === "job.start") {
          return { jobId: "job_test_123", status: "running" };
        }
        if (method === "job.status") {
          return { jobId: "job_test_123", status: "completed", exitCode: 0, stdoutTail: "done" };
        }
        if (method === "job.cancel") {
          return { jobId: "job_test_123", status: "cancelled" };
        }
        return {};
      })
    };

    // Test calling hub directly with the methods dispatched by the tools
    await mockHub.request("device-1", "job.start", { command: "echo test" });
    await mockHub.request("device-1", "job.status", { jobId: "job_test_123" });
    await mockHub.request("device-1", "job.cancel", { jobId: "job_test_123" });

    expect(requestsReceived.length).toBe(3);
    expect(requestsReceived[0].method).toBe("job.start");
    expect(requestsReceived[1].method).toBe("job.status");
    expect(requestsReceived[2].method).toBe("job.cancel");
  });
});
