import http from "node:http";
import type { AddressInfo } from "node:net";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNomsodMcpHandler, MCP_MAX_REQUEST_BODY_BYTES } from "../src/gateway/mcp.js";

const cleanup: Array<() => Promise<void>> = [];
const maxBodyBytes = 2 * 1024 * 1024;

afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const request = vi.fn(async (deviceId: string) => ({ deviceId, ok: true }));
  const handler = createNomsodMcpHandler({ listDevices: async () => [], request });
  cleanup.push(() => handler.close());
  const nodeHandler = toNodeHandler(handler, { maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES });
  const server = http.createServer((req, res) => void nodeHandler(req, res));
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    server.close(() => resolve());
    server.closeAllConnections();
  }));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  async function call(name: string, args: Record<string, unknown>, id = 1) {
    return fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18"
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } })
    });
  }
  return { call, request, url };
}

async function message(response: Response) {
  const raw = await response.text();
  if (response.headers.get("content-type")?.includes("application/json")) return JSON.parse(raw);
  const line = raw.split(/\r?\n/).find(value => value.startsWith("data: "));
  expect(line).toBeDefined();
  return JSON.parse(line!.slice(6));
}

describe("MCP request boundaries over HTTP", () => {
  it("dispatches normal requests and keeps simultaneous clients with matching ids isolated", async () => {
    const { call, request } = await fixture();
    const replies = await Promise.all(["mac", "undie"].map(async deviceId => {
      const response = await call("get_system_info", { deviceId });
      expect(response.status).toBe(200);
      return JSON.parse((await message(response)).result.content[0].text);
    }));
    expect(replies.map(reply => reply.deviceId)).toEqual(["mac", "undie"]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects excessive argument elements before dispatch and accepts the next valid call", async () => {
    const { call, request } = await fixture();
    const response = await call("desktop_key_press", {
      deviceId: "mac", key: "c", modifiers: Array(10_001).fill("ctrl")
    });
    expect(response.status).toBe(200);
    expect((await message(response)).result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
    expect((await message(await call("get_system_info", { deviceId: "mac" }))).result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("bounds UTF-8 request bytes and remains available after rejecting a large body", async () => {
    const { call, request } = await fixture();
    try {
      const response = await call("desktop_type", {
        deviceId: "undie", text: "\u0e01".repeat(Math.ceil(maxBodyBytes / 3))
      });
      expect(response.status).toBe(413);
      await response.text();
    } catch (error) {
      // The SDK closes early on 413; macOS may reset an upload still in flight.
      expect(process.platform).toBe("darwin");
      expect((error as Error & { cause?: { code?: string } }).cause?.code).toBe("ECONNRESET");
    }
    expect(request).not.toHaveBeenCalled();
    const valid = await message(await call("get_system_info", { deviceId: "undie" }));
    expect(valid.result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("returns 413 for an oversized Content-Length before the client uploads the body", async () => {
    const { url, request } = await fixture();
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const upload = http.request(url, {
        method: "POST", headers: { "content-type": "application/json", "content-length": maxBodyBytes + 1 }
      }, response => {
        response.resume();
        response.on("end", () => resolve(response.statusCode));
      });
      upload.on("error", reject);
      upload.setTimeout(3000, () => upload.destroy(new Error("Oversize rejection timed out")));
      upload.flushHeaders();
    });
    expect(status).toBe(413);
    expect(request).not.toHaveBeenCalled();
  });

  it("allows UTF-8 file content just below the request byte limit", async () => {
    const { call, request } = await fixture();
    const content = "\u0e01".repeat(Math.floor((maxBodyBytes - 1024) / 3));
    const response = await call("write_text_file", { deviceId: "mac", path: "example.txt", content });
    expect(response.status).toBe(200);
    expect((await message(response)).result.isError).not.toBe(true);
    expect(request).toHaveBeenCalledExactlyOnceWith("mac", "fs.write", {
      path: "example.txt", content, expectedSha256: undefined
    });
  });
});
