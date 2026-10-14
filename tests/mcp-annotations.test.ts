import { describe, expect, it } from "vitest";
import {
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
