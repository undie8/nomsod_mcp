import { describe, expect, it } from "vitest";
import { locateBrowser } from "../src/agent/browser-launcher.js";
import { browserManager } from "../src/agent/browser-manager.js";

describe("Browser Automation CDP", () => {
  it("should locate installed Chrome or Edge executable", async () => {
    const executable = await locateBrowser({ browser: "any" });
    expect(executable).toBeTruthy();
    expect(typeof executable).toBe("string");
  });

  it("should navigate, snapshot, type, click, and take screenshot using data URL", async () => {
    const dataUrl =
      "data:text/html,<html><head><title>Nomsod Test</title></head><body><h1>Hello World</h1><input id=\"inp\" type=\"text\" /><button id=\"btn\" onclick=\"console.log('clicked')\">Submit</button></body></html>";

    try {
      const navRes = await browserManager.navigate({ url: dataUrl, timeoutMs: 15000 });
      expect(navRes.ok).toBe(true);
      expect(navRes.title).toBe("Nomsod Test");

      const snapshot = await browserManager.snapshot();
      expect(snapshot.title).toBe("Nomsod Test");
      expect(snapshot.htmlSnippet).toContain("Hello World");

      const typeRes = await browserManager.type({ selector: "#inp", text: "testing 123" });
      expect(typeRes.ok).toBe(true);
      expect(typeRes.textLength).toBe(11);

      const clickRes = await browserManager.click({ selector: "#btn" });
      expect(clickRes.ok).toBe(true);

      const screenshot = await browserManager.screenshot();
      expect(screenshot.mimeType).toBe("image/png");
      expect(screenshot.base64.length).toBeGreaterThan(100);
      expect(screenshot.bytes).toBeGreaterThan(100);
    } finally {
      await browserManager.close();
    }
  }, 30_000);
});
