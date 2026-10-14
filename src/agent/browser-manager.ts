import WebSocket from "ws";
import type {
  BrowserClickParams,
  BrowserClickResult,
  BrowserCloseResult,
  BrowserConsoleLog,
  BrowserNavigateParams,
  BrowserNavigateResult,
  BrowserScreenshotParams,
  BrowserScreenshotResult,
  BrowserSnapshotParams,
  BrowserSnapshotResult,
  BrowserTypeParams,
  BrowserTypeResult
} from "../shared/browser-types.js";
import { launchBrowser, type LaunchedBrowser } from "./browser-launcher.js";

export class BrowserManager {
  private browser: LaunchedBrowser | null = null;
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pendingRequests = new Map<
    number,
    { resolve: (val: any) => void; reject: (err: any) => void; timer: NodeJS.Timeout; method: string }
  >();
  private eventListeners = new Map<string, Set<(params: any) => void>>();
  private consoleLogs: BrowserConsoleLog[] = [];
  private hasErrors = false;

  private async ensureBrowser(): Promise<void> {
    if (this.browser && this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }

    if (this.browser) {
      await this.close();
    }

    this.browser = await launchBrowser({ headless: true });
    this.consoleLogs = [];
    this.hasErrors = false;

    const res = await fetch(`http://127.0.0.1:${this.browser.port}/json`);
    if (!res.ok) {
      throw new Error(`Failed to fetch browser targets from port ${this.browser.port}`);
    }

    const targets = (await res.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
    const pageTarget = targets.find((t) => t.type === "page") || targets[0];
    if (!pageTarget || !pageTarget.webSocketDebuggerUrl) {
      throw new Error("No valid browser page target found.");
    }

    await this.connectWs(pageTarget.webSocketDebuggerUrl);

    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");

    this.on("Runtime.consoleAPICalled", (params: any) => {
      const type = params.type === "error" ? "error" : params.type === "warning" ? "warn" : "log";
      if (type === "error") this.hasErrors = true;
      const text = (params.args || [])
        .map((a: any) => (a.value !== undefined ? String(a.value) : a.description || ""))
        .join(" ");
      this.consoleLogs.push({
        type,
        text,
        timestamp: Date.now()
      });
      if (this.consoleLogs.length > 200) {
        this.consoleLogs.shift();
      }
    });

    this.on("Runtime.exceptionThrown", (params: any) => {
      this.hasErrors = true;
      const desc = params.exceptionDetails?.exception?.description || params.exceptionDetails?.text || "Unknown exception";
      this.consoleLogs.push({
        type: "error",
        text: desc,
        timestamp: Date.now()
      });
      if (this.consoleLogs.length > 200) {
        this.consoleLogs.shift();
      }
    });
  }

  private async connectWs(url: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error("Timeout connecting to browser WebSocket debugger"));
      }, 10000);

      ws.on("open", () => {
        clearTimeout(timer);
        this.ws = ws;
        resolve();
      });

      ws.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });

      ws.on("message", (raw) => {
        this.handleMessage(raw.toString());
      });

      ws.on("close", () => {
        for (const [, pending] of this.pendingRequests.entries()) {
          clearTimeout(pending.timer);
          pending.reject(new Error(`CDP connection closed while waiting for ${pending.method}`));
        }
        this.pendingRequests.clear();
        this.ws = null;
      });
    });
  }

  private handleMessage(data: string): void {
    let msg: any;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (msg.id !== undefined) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(`CDP Error [${pending.method}]: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }

    if (msg.method) {
      const listeners = this.eventListeners.get(msg.method);
      if (listeners) {
        for (const cb of listeners) {
          try {
            cb(msg.params);
          } catch {}
        }
      }
    }
  }

  private async send(method: string, params: Record<string, unknown> = {}, timeoutMs = 30000): Promise<any> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("CDP WebSocket is not connected");
    }

    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP command timeout: ${method} (id: ${id})`));
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, reject, timer, method });
      this.ws!.send(payload, (err) => {
        if (err) {
          clearTimeout(timer);
          this.pendingRequests.delete(id);
          reject(err);
        }
      });
    });
  }

  private on(method: string, callback: (params: any) => void): () => void {
    if (!this.eventListeners.has(method)) {
      this.eventListeners.set(method, new Set());
    }
    this.eventListeners.get(method)!.add(callback);
    return () => {
      this.eventListeners.get(method)?.delete(callback);
    };
  }

  public async navigate(params: BrowserNavigateParams): Promise<BrowserNavigateResult> {
    await this.ensureBrowser();
    const timeoutMs = params.timeoutMs || 30000;

    return new Promise(async (resolve, reject) => {
      let resolved = false;
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Navigation timeout after ${timeoutMs}ms for ${params.url}`));
        }
      }, timeoutMs);

      const removeListener = this.on("Page.loadEventFired", async () => {
        if (!resolved) {
          resolved = true;
          cleanup();
          try {
            const evalRes = await this.send("Runtime.evaluate", {
              expression: "({ title: document.title, url: location.href })",
              returnByValue: true
            });
            const val = evalRes?.result?.value || {};
            resolve({
              ok: true,
              url: val.url || params.url,
              title: val.title || ""
            });
          } catch (e: any) {
            resolve({
              ok: true,
              url: params.url,
              title: ""
            });
          }
        }
      });

      const cleanup = () => {
        clearTimeout(timer);
        removeListener();
      };

      try {
        await this.send("Page.navigate", { url: params.url });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  public async click(params: BrowserClickParams): Promise<BrowserClickResult> {
    await this.ensureBrowser();
    const selector = params.selector;
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.click();
        return { success: true };
      })()
    `;

    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const val = res?.result?.value;
    if (!val || !val.success) {
      throw new Error(val?.error || `Failed to click selector: ${selector}`);
    }

    return { ok: true, selector };
  }

  public async type(params: BrowserTypeParams): Promise<BrowserTypeResult> {
    await this.ensureBrowser();
    const { selector, text, clearFirst = true } = params;
    const expr = `
      (function() {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { success: false, error: 'Element not found: ' + ${JSON.stringify(selector)} };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        el.focus();
        if (${clearFirst}) {
          el.value = '';
        }
        el.value += ${JSON.stringify(text)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, length: el.value.length };
      })()
    `;

    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const val = res?.result?.value;
    if (!val || !val.success) {
      throw new Error(val?.error || `Failed to type into selector: ${selector}`);
    }

    return { ok: true, selector, textLength: val.length || text.length };
  }

  public async snapshot(params: BrowserSnapshotParams = {}): Promise<BrowserSnapshotResult> {
    await this.ensureBrowser();
    const maxDepth = params.maxDepth || 4;

    const expr = `
      (function() {
        function getTree(node, depth) {
          if (depth > ${maxDepth}) return '';
          if (!node) return '';
          if (node.nodeType === Node.TEXT_NODE) {
            const t = node.textContent ? node.textContent.trim() : '';
            return t ? t : '';
          }
          if (node.nodeType === Node.ELEMENT_NODE) {
            const tag = node.tagName.toLowerCase();
            if (['script', 'style', 'noscript', 'svg', 'path'].includes(tag)) return '';
            let attrs = '';
            if (node.id) attrs += ' id="' + node.id + '"';
            if (node.className && typeof node.className === 'string') attrs += ' class="' + node.className.trim() + '"';
            if (node.getAttribute('role')) attrs += ' role="' + node.getAttribute('role') + '"';
            if (node.getAttribute('aria-label')) attrs += ' aria-label="' + node.getAttribute('aria-label') + '"';
            if (tag === 'a' && node.href) attrs += ' href="' + node.href + '"';
            if (tag === 'button') attrs += ' button';
            if (tag === 'input' && node.type) attrs += ' type="' + node.type + '" value="' + node.value + '"';

            const children = Array.from(node.childNodes)
              .map(c => getTree(c, depth + 1))
              .filter(Boolean)
              .join(' ');
            return '<' + tag + attrs + '>' + (children ? ' ' + children : '') + '</' + tag + '>';
          }
          return '';
        }
        return {
          title: document.title,
          url: location.href,
          htmlSnippet: document.body ? getTree(document.body, 0).slice(0, 4000) : ''
        };
      })()
    `;

    const res = await this.send("Runtime.evaluate", { expression: expr, returnByValue: true });
    const val = res?.result?.value || {};

    return {
      url: val.url || "",
      title: val.title || "",
      htmlSnippet: val.htmlSnippet || "",
      consoleLogs: [...this.consoleLogs],
      hasErrors: this.hasErrors
    };
  }

  public async screenshot(params: BrowserScreenshotParams = {}): Promise<BrowserScreenshotResult> {
    await this.ensureBrowser();
    const fullPage = params.fullPage || false;

    if (fullPage) {
      try {
        const metrics = await this.send("Page.getLayoutMetrics");
        const contentSize = metrics?.contentSize || metrics?.cssContentSize;
        if (contentSize && contentSize.width > 0 && contentSize.height > 0) {
          await this.send("Emulation.setDeviceMetricsOverride", {
            mobile: false,
            width: Math.ceil(contentSize.width),
            height: Math.ceil(contentSize.height),
            deviceScaleFactor: 1
          });
        }
      } catch {}
    }

    const res = await this.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage
    });

    const base64 = res.data;
    const bytes = Math.round((base64.length * 3) / 4);

    return {
      base64,
      mimeType: "image/png",
      bytes
    };
  }

  public async close(): Promise<BrowserCloseResult> {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {}
      this.ws = null;
    }

    if (this.browser) {
      try {
        await this.browser.close();
      } catch {}
      this.browser = null;
    }

    this.consoleLogs = [];
    this.hasErrors = false;
    return { ok: true, message: "Browser closed successfully" };
  }
}

export const browserManager = new BrowserManager();
