import { describe, expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { captureScreenshot, readImageFile } from "../src/agent/visual-helper.js";

describe("visual-helper", () => {
  it("should read svg and detect dimensions and mimeType", async () => {
    const tempSvg = path.join(os.tmpdir(), `test-image-${Date.now()}.svg`);
    const svgContent = `<svg width="200" height="100" xmlns="http://www.w3.org/2000/svg"><rect width="200" height="100" fill="red"/></svg>`;
    await fs.writeFile(tempSvg, svgContent, "utf8");

    try {
      const res = await readImageFile(tempSvg);
      expect(res.mimeType).toBe("image/svg+xml");
      expect(res.width).toBe(200);
      expect(res.height).toBe(100);
      expect(res.base64).toBeTruthy();
      expect(res.bytes).toBeGreaterThan(0);
    } finally {
      await fs.unlink(tempSvg);
    }
  });

  it("should read 1x1 png and detect dimensions", async () => {
    // 1x1 transparent PNG buffer
    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
    const tempPng = path.join(os.tmpdir(), `test-image-${Date.now()}.png`);
    await fs.writeFile(tempPng, Buffer.from(pngBase64, "base64"));

    try {
      const res = await readImageFile(tempPng);
      expect(res.mimeType).toBe("image/png");
      expect(res.width).toBe(1);
      expect(res.height).toBe(1);
      expect(res.base64).toBe(pngBase64);
    } finally {
      await fs.unlink(tempPng);
    }
  });

  it("should reject non-image file or missing file", async () => {
    await expect(readImageFile("non-existent-image.png")).rejects.toThrow("Image file not found");
  });

  it("should capture screenshot on Windows without error", async () => {
    if (process.platform !== "win32") return;
    const result = await captureScreenshot({ screenMode: "primary" });
    expect(result.mimeType).toBe("image/png");
    expect(result.base64.length).toBeGreaterThan(100);
    expect(result.bytes).toBeGreaterThan(100);
    expect(result.capturedAt).toBeGreaterThan(0);
  }, 20_000);
});
