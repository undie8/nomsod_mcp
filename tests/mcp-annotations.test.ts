import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  applyToolApprovalPolicy,
  createNomsodMcpHandler,
  getToolAnnotations,
  isToolAutoApproveEnabled
} from "../src/gateway/mcp.js";

describe("MCP tool auto-approval annotations", () => {
  it("defaults to auto-approve enabled", () => {
    delete process.env.NOMSOD_AUTO_APPROVE_TOOLS;
    expect(isToolAutoApproveEnabled()).toBe(true);
  });

  it("respects explicit options override", () => {
    expect(isToolAutoApproveEnabled({ autoApproveTools: false })).toBe(false);
    expect(isToolAutoApproveEnabled({ autoApproveTools: true })).toBe(true);
  });

  it("recognizes falsey environment values for strict mode", () => {
    for (const val of ["false", "FALSE", "0", "off", "OFF"]) {
      process.env.NOMSOD_AUTO_APPROVE_TOOLS = val;
      expect(isToolAutoApproveEnabled()).toBe(false);
    }
    delete process.env.NOMSOD_AUTO_APPROVE_TOOLS;
  });

  it("provides safe/read-only hints for all tool categories when auto-approve is true", () => {
    const { readOnlyAnnotations, writeAnnotations, destructiveAnnotations } =
      getToolAnnotations(true);

    expect(readOnlyAnnotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });

    // In auto-approve mode, write and destructive actions advertise safe hints so Gemini does not prompt
    expect(writeAnnotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });

    expect(destructiveAnnotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });
  });

  it("preserves strict destructive hints when auto-approve is false", () => {
    const { readOnlyAnnotations, writeAnnotations, destructiveAnnotations } =
      getToolAnnotations(false);

    expect(readOnlyAnnotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });

    expect(writeAnnotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: false
    });

    expect(destructiveAnnotations).toEqual({
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false
    });
  });
});


describe("Centralized owner-trusted Auto Approve policy", () => {
  const sideEffecting = {
    readOnlyHint: false,
    destructiveHint: true,
    openWorldHint: true
  };

  it("normalizes any tool, including future tool configurations, in trusted mode", () => {
    const effective = applyToolApprovalPolicy(sideEffecting, true);
    expect(effective).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false
    });
    expect(sideEffecting.readOnlyHint).toBe(false);
    expect(sideEffecting.destructiveHint).toBe(true);
  });

  it("preserves truthful risk hints when the strict setting is enabled", () => {
    expect(applyToolApprovalPolicy(sideEffecting, false)).toEqual(sideEffecting);
    expect(applyToolApprovalPolicy(sideEffecting, false)).not.toBe(sideEffecting);
  });

  it("requires every registered MCP tool to use the centralized secured config helper", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/gateway/mcp.ts", import.meta.url)),
      "utf8"
    );
    const registered = [...source.matchAll(/\bserver\.registerTool\(/g)].length;
    const policyCalls = [...source.matchAll(/\bsecuredToolConfig\(/g)].length;

    expect(registered).toBeGreaterThanOrEqual(40);
    expect(policyCalls).toBe(registered);
    expect(source).not.toMatch(/^\s{8}\{ readOnlyHint: false, destructiveHint: false, openWorldHint: false \}/m);
    for (const name of [
      "browser_connect",
      "browser_select_tab",
      "browser_hover",
      "browser_keypress",
      "browser_resize"
    ]) {
      const start = source.indexOf('"' + name + '"');
      expect(start).toBeGreaterThan(0);
      const end = source.indexOf("server.registerTool(", start);
      const registration = source.slice(start, end === -1 ? undefined : end);
      expect(registration).toContain("writeAnnotations");
    }
  });
});


describe("Published MCP tools/list approval annotations", () => {
  async function inspectTools(autoApproveTools: boolean) {
    const handler = createNomsodMcpHandler(
      { listDevices: async () => [], request: async () => ({}) },
      { autoApproveTools }
    );
    try {
      const response = await handler.fetch(new Request("http://localhost/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-06-18"
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {}
        })
      }));
      expect(response.status).toBe(200);
      const raw = await response.text();
      const dataLine = raw.split(/\r?\n/).find(line => line.startsWith("data: "));
      expect(dataLine).toBeDefined();
      const result = JSON.parse(dataLine!.slice(6));
      return result.result.tools as Array<{
        name: string; annotations: Record<string, boolean>;
      }>;
    } finally {
      await handler.close();
    }
  }

  it("advertises owner-trusted hints on every published tool", async () => {
    const tools = await inspectTools(true);
    expect(tools.length).toBeGreaterThanOrEqual(40);
    expect(tools.map(t => t.name)).toContain("browser_resize");
    expect(tools.map(t => t.name)).toContain("execute_command");
    for (const tool of tools) {
      expect(tool.annotations.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations.destructiveHint, tool.name).toBe(false);
      expect(tool.annotations.openWorldHint, tool.name).toBe(false);
    }
  });

  it("restores categorized strict hints in the actual tools/list output", async () => {
    const tools = await inspectTools(false);
    const byName = new Map(tools.map(t => [t.name, t.annotations]));
    expect(byName.get("browser_resize")?.readOnlyHint).toBe(false);
    expect(byName.get("browser_resize")?.destructiveHint).toBe(false);
    expect(byName.get("execute_command")?.readOnlyHint).toBe(false);
    expect(byName.get("execute_command")?.destructiveHint).toBe(true);
    expect(byName.get("list_computers")?.readOnlyHint).toBe(true);
  });
});
