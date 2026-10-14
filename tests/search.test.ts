import { describe, expect, it } from "vitest";
import path from "node:path";
import { searchFiles } from "../src/agent/search-helper.js";

describe("searchFiles", () => {
  it("should find matches in existing codebase files", async () => {
    const result = await searchFiles({
      query: "JobManager",
      path: path.resolve(process.cwd(), "src"),
      pattern: "*.ts"
    });

    expect(result.totalFilesScanned).toBeGreaterThan(0);
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches[0]).toHaveProperty("file");
    expect(result.matches[0]).toHaveProperty("line");
    expect(result.matches[0]).toHaveProperty("column");
    expect(result.matches[0]).toHaveProperty("preview");
    expect(result.matches.some(m => m.preview.includes("JobManager"))).toBe(true);
  });

  it("should respect pattern filtering", async () => {
    const result = await searchFiles({
      query: "version",
      path: path.resolve(process.cwd()),
      pattern: "*.json",
      maxResults: 5
    });

    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.every(m => m.file.endsWith(".json"))).toBe(true);
  });

  it("should respect maxResults limit and set truncated flag", async () => {
    const result = await searchFiles({
      query: "export",
      path: path.resolve(process.cwd(), "src"),
      maxResults: 3
    });

    expect(result.matches.length).toBe(3);
    expect(result.truncated).toBe(true);
  });
});
