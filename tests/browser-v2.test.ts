import { afterEach, describe, expect, it } from "vitest";
import http from "node:http";
import { browserManager } from "../src/agent/browser-manager.js";
import { launchBrowser, type LaunchedBrowser } from "../src/agent/browser-launcher.js";

describe("Nomsod Browser V2", () => {
  let launched: LaunchedBrowser | undefined;
  afterEach(async () => {
    await browserManager.close();
    if (launched) {
      await launched.close();
      launched = undefined;
    }
  });

  it("attaches to an approved local Chrome and runs QA without exporting credentials", async () => {
    const server = http.createServer((req, res) => {
      if (req.url?.startsWith("/failed")) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("not found");
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end([
        "<!doctype html><html><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>QA fixture</title></head><body>",
        "<button id='ok' aria-label='Tester'>Test</button>",
        "<input id='unlabeled'>",
        "<input id='password-field' type='password' value='NEVER_SHOW_THIS_PASSWORD'>",
        "<img src='data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs='>",
        "<script>fetch('/failed?password=private&token=secret').catch(()=>{});</script>",
        "</body></html>"
      ].join(""));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing test port");
    try {
      launched = await launchBrowser({ headless: true });
      const connected = await browserManager.connect({ port: launched.port });
      expect(connected.ok).toBe(true);
      expect(connected.mode).toBe("attached");

      const tabs = await browserManager.listTabs();
      expect(tabs.mode).toBe("attached");
      expect(tabs.tabs.length).toBeGreaterThan(0);
      expect(tabs.tabs.some(t => t.selected)).toBe(true);

      const url = "http://127.0.0.1:" + address.port + "/";
      const navigated = await browserManager.navigate({ url, timeoutMs: 18000 });
      expect(navigated.ok).toBe(true);
      await browserManager.waitFor({ selector: "#ok", visible: true, timeoutMs: 12000 });
      expect((await browserManager.hover("#ok")).ok).toBe(true);
      expect((await browserManager.keypress({ key: "Tab" })).ok).toBe(true);
      expect((await browserManager.resize({ width: 375, height: 812, mobile: true })).width).toBe(375);

      const audit = await browserManager.audit();
      expect(audit.viewport.width).toBe(375);
      expect(audit.missingImageAlt).toBe(1);
      expect(audit.unlabeledInputs).toBeGreaterThanOrEqual(1);
      const network = await browserManager.networkMessages({ failuresOnly: true });
      expect(network.requests.some(x => x.status === 404)).toBe(true);
      expect(JSON.stringify(network)).not.toContain("password=private");
      expect(JSON.stringify(network)).not.toContain("token=secret");
      const dom = await browserManager.snapshot({ maxDepth: 5 });
      expect(dom.htmlSnippet).not.toContain("NEVER_SHOW_THIS_PASSWORD");
      const messages = await browserManager.consoleMessages({ errorsOnly: true });
      expect(Array.isArray(messages.messages)).toBe(true);

      const disconnected = await browserManager.close();
      expect(disconnected.ok).toBe(true);
      // The browser belongs to the caller and must not be terminated by disconnect.
      expect(launched.process.exitCode).toBeNull();
    } finally {
      await browserManager.close();
      if (launched) { await launched.close(); launched = undefined; }
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }, 60000);

  it("rejects non-local / invalid CDP endpoints", async () => {
    await expect(browserManager.connect({ port: 80 })).rejects.toThrow("CDP port");
  });
});
