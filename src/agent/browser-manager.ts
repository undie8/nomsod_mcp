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

type BrowserNetworkRecord = {
  requestId: string; method?: string; url: string; type?: string;
  status?: number; error?: string; timestamp: number;
};

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

  private attachedPort: number | null = null;
  private activeTargetId: string | null = null;
  private networkRequests: BrowserNetworkRecord[] = [];

  private async targets(port: number): Promise<Array<{
    id: string; type: string; title: string; url: string; webSocketDebuggerUrl?: string;
  }>> {
    const res = await fetch("http://127.0.0.1:" + port + "/json/list", {
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) throw new Error("Chrome DevTools not responding on localhost port " + port);
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error("Unexpected Chrome DevTools targets response");
    return body.filter((item: any) => item && item.type === "page" && typeof item.id === "string");
  }

  private safeUrl(raw: string): string {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    } catch {
      return String(raw || "").split(/[?#]/, 1)[0].slice(0, 500);
    }
  }

  private safeDiagnosticText(raw: string): string {
    return String(raw || "").slice(0, 1500)
      .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+/gi, "$1[REDACTED]")
      .replace(/((?:access_token|refresh_token|id_token|password|authorization|cookie)\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;]+)/gi, "$1[REDACTED]")
      .replace(/\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "[JWT REDACTED]");
  }

  private rememberRequest(requestId: string, change: Record<string, unknown>): void {
    const previous = this.networkRequests.find(item => item.requestId === requestId);
    if (previous) {
      Object.assign(previous, change);
    } else {
      this.networkRequests.push({ requestId, url: "", timestamp: Date.now(), ...change });
      if (this.networkRequests.length > 250) this.networkRequests.shift();
    }
  }

  private registerDiagnostics(): void {
    this.eventListeners.clear();
    this.consoleLogs = [];
    this.hasErrors = false;
    this.networkRequests = [];
    this.on("Runtime.consoleAPICalled", (params: any) => {
      const type: BrowserConsoleLog["type"] =
        params.type === "error" ? "error" : params.type === "warning" ? "warn" : "log";
      if (type === "error") this.hasErrors = true;
      const message = (params.args || [])
        .map((a: any) => a.value === undefined ? (a.description || "") : String(a.value))
        .join(" ");
      this.consoleLogs.push({ type, text: this.safeDiagnosticText(message), timestamp: Date.now() });
      if (this.consoleLogs.length > 200) this.consoleLogs.shift();
    });
    this.on("Runtime.exceptionThrown", (params: any) => {
      this.hasErrors = true;
      const message = params.exceptionDetails?.exception?.description ||
        params.exceptionDetails?.text || "Unknown exception";
      this.consoleLogs.push({ type: "error", text: this.safeDiagnosticText(message), timestamp: Date.now() });
      if (this.consoleLogs.length > 200) this.consoleLogs.shift();
    });
    this.on("Network.requestWillBeSent", (params: any) => {
      const requestId = String(params.requestId || "");
      if (!requestId) return;
      this.rememberRequest(requestId, {
        url: this.safeUrl(params.request?.url || ""),
        method: params.request?.method || "GET",
        type: params.type || "Other",
        timestamp: Date.now()
      });
    });
    this.on("Network.responseReceived", (params: any) => {
      const requestId = String(params.requestId || "");
      if (!requestId) return;
      this.rememberRequest(requestId, {
        url: this.safeUrl(params.response?.url || ""),
        status: params.response?.status,
        type: params.type || "Other"
      });
    });
    this.on("Network.loadingFailed", (params: any) => {
      const requestId = String(params.requestId || "");
      if (!requestId) return;
      this.rememberRequest(requestId, {
        error: String(params.errorText || "Network loading failed").slice(0, 250)
      });
    });
  }

  private async connectTarget(target: { id: string; webSocketDebuggerUrl?: string }, port: number): Promise<void> {
    if (!target.webSocketDebuggerUrl) throw new Error("Selected Chrome tab does not expose a CDP endpoint");
    const endpoint = new URL(target.webSocketDebuggerUrl);
    if (endpoint.protocol !== "ws:" ||
        !["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) ||
        Number(endpoint.port) !== port) {
      throw new Error("Only loopback Chrome DevTools endpoints are allowed");
    }
    if (this.ws) {
      const previous = this.ws;
      this.ws = null;
      previous.close();
    }
    await this.connectWs(endpoint.toString());
    this.activeTargetId = target.id;
    this.registerDiagnostics();
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("DOM.enable");
    await this.send("Network.enable", { maxTotalBufferSize: 1000000 });
  }

  private async ensureBrowser(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    if (this.attachedPort !== null) {
      const available = await this.targets(this.attachedPort);
      const target = available.find(t => t.id === this.activeTargetId) || available[0];
      if (!target) throw new Error("Attached Chrome has no accessible page; reconnect or select a tab");
      await this.connectTarget(target, this.attachedPort);
      return;
    }
    if (this.browser) await this.close();
    this.browser = await launchBrowser({ headless: true });
    const available = await this.targets(this.browser.port);
    const target = available[0];
    if (!target) throw new Error("No Chrome page found in headless browser");
    await this.connectTarget(target, this.browser.port);
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
        if (this.ws === ws) this.ws = null;
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
            // Do not reveal typed input values, passwords, or account identifiers in snapshots.
            if (tag === 'input' && node.type) attrs += ' type="' + node.type + '"';

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

    // Avoid changing a user-owned Chrome window when capturing a full-page screenshot.
    if (fullPage && this.attachedPort === null) {
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


  /** Attach only to a user-enabled local debugging port. Does not read cookies or passwords. */
  public async connect(params: { port: number; urlContains?: string }): Promise<{
    ok: boolean; mode: "attached"; port: number; targetId: string; url: string; title: string;
  }> {
    const port = params.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      throw new Error("CDP port must be an integer between 1024 and 65535");
    }
    const available = await this.targets(port);
    const target = params.urlContains
      ? available.find(t => t.url.includes(params.urlContains!))
      : available[0];
    if (!target) throw new Error("No matching Chrome tab found. Open the page in Chrome first.");
    if (this.browser) await this.close();
    this.attachedPort = port;
    try {
      await this.connectTarget(target, port);
      return {
        ok: true, mode: "attached", port, targetId: target.id,
        url: this.safeUrl(target.url), title: target.title
      };
    } catch (err) {
      this.attachedPort = null;
      throw err;
    }
  }

  public async listTabs(): Promise<{
    mode: "attached" | "headless";
    tabs: Array<{ id: string; title: string; url: string; selected: boolean }>;
  }> {
    if (this.attachedPort === null && !this.browser) await this.ensureBrowser();
    const port = this.attachedPort ?? this.browser!.port;
    const tabs = await this.targets(port);
    return {
      mode: this.attachedPort !== null ? "attached" : "headless",
      tabs: tabs.map(t => ({
        id: t.id, title: t.title, url: this.safeUrl(t.url), selected: t.id === this.activeTargetId
      }))
    };
  }

  public async selectTab(targetId: string): Promise<{ ok: boolean; targetId: string; url: string }> {
    if (this.attachedPort === null && !this.browser) throw new Error("Connect to Chrome or navigate first");
    const port = this.attachedPort ?? this.browser!.port;
    const target = (await this.targets(port)).find(t => t.id === targetId);
    if (!target) throw new Error("Requested tab not found");
    await this.connectTarget(target, port);
    return { ok: true, targetId, url: this.safeUrl(target.url) };
  }

  public async hover(selector: string): Promise<{ ok: boolean; selector: string }> {
    await this.ensureBrowser();
    const expression = "(() => { const e=document.querySelector(" + JSON.stringify(selector) +
      "); if(!e) return null; e.scrollIntoView({block:'center'});" +
      "const r=e.getBoundingClientRect(); if(!r.width||!r.height) return null;" +
      "return {x:r.left+r.width/2,y:r.top+r.height/2}; })()";
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    const point = result?.result?.value;
    if (!point) throw new Error("Hover target missing or hidden: " + selector);
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: point.x, y: point.y });
    return { ok: true, selector };
  }

  public async keypress(params: { key: string; modifiers?: Array<"Alt" | "Control" | "Meta" | "Shift"> }): Promise<{
    ok: boolean; key: string;
  }> {
    await this.ensureBrowser();
    const keyCodes: Record<string, number> = {
      Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46,
      ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32
    };
    const key = params.key;
    if (!Object.hasOwn(keyCodes, key) && !/^[a-zA-Z0-9]$/.test(key)) {
      throw new Error("Unsupported key: " + key);
    }
    const mask: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
    const modifiers = (params.modifiers || []).reduce((sum, item) => sum | (mask[item] || 0), 0);
    const windowsVirtualKeyCode = keyCodes[key] ?? key.toUpperCase().charCodeAt(0);
    const args = { key: key === "Space" ? " " : key, modifiers, windowsVirtualKeyCode };
    await this.send("Input.dispatchKeyEvent", { type: "keyDown", ...args });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", ...args });
    return { ok: true, key };
  }

  public async resize(params: { width: number; height: number; mobile?: boolean; deviceScaleFactor?: number }): Promise<{
    ok: boolean; width: number; height: number; mobile: boolean;
  }> {
    await this.ensureBrowser();
    const { width, height, mobile = false, deviceScaleFactor = 1 } = params;
    if (!Number.isInteger(width) || width < 240 || width > 3840 ||
        !Number.isInteger(height) || height < 240 || height > 2160 ||
        !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 0.5 || deviceScaleFactor > 4) {
      throw new Error("Invalid viewport size or device scale factor");
    }
    await this.send("Emulation.setDeviceMetricsOverride", { width, height, mobile, deviceScaleFactor });
    return { ok: true, width, height, mobile };
  }

  public async waitFor(params: { selector: string; timeoutMs?: number; visible?: boolean }): Promise<{
    ok: boolean; selector: string; elapsedMs: number;
  }> {
    await this.ensureBrowser();
    const timeout = Math.min(Math.max(params.timeoutMs || 10000, 200), 30000);
    const started = Date.now();
    const expression = "(() => {const el=document.querySelector(" + JSON.stringify(params.selector) +
      "); if(!el) return false; if(!" + Boolean(params.visible) + ")return true;" +
      "const r=el.getBoundingClientRect(); const s=getComputedStyle(el);" +
      "return r.width>0&&r.height>0&&s.visibility!=='hidden'&&s.display!=='none'; })()";
    while (Date.now() - started < timeout) {
      const result = await this.send("Runtime.evaluate", { expression, returnByValue: true }, 5000);
      if (result?.result?.value === true) {
        return { ok: true, selector: params.selector, elapsedMs: Date.now() - started };
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    throw new Error("Timed out waiting for element: " + params.selector);
  }

  public async consoleMessages(params: { errorsOnly?: boolean; limit?: number } = {}): Promise<{
    count: number; messages: BrowserConsoleLog[];
  }> {
    await this.ensureBrowser();
    const messages = params.errorsOnly ? this.consoleLogs.filter(x => x.type === "error") : this.consoleLogs;
    const limit = Math.min(Math.max(params.limit || 50, 1), 200);
    return { count: messages.length, messages: messages.slice(-limit) };
  }

  public async networkMessages(params: { failuresOnly?: boolean; limit?: number } = {}): Promise<{
    count: number; requests: BrowserNetworkRecord[];
  }> {
    await this.ensureBrowser();
    const requests = params.failuresOnly
      ? this.networkRequests.filter(x => (x.status ?? 0) >= 400 || Boolean(x.error))
      : this.networkRequests;
    const limit = Math.min(Math.max(params.limit || 50, 1), 200);
    return { count: requests.length, requests: requests.slice(-limit) };
  }

  /** Lightweight, read-only accessibility, responsive and navigation performance check. */
  public async audit(): Promise<{
    url: string;
    viewport: { width: number; height: number; documentWidth: number };
    horizontalOverflow: boolean;
    missingImageAlt: number;
    unlabeledInputs: number;
    unlabeledButtons: number;
    navigationTiming: Record<string, number> | null;
  }> {
    await this.ensureBrowser();
    const expression = [
      "(() => {",
      "const inputs=[...document.querySelectorAll('input:not([type=hidden]),select,textarea')];",
      "const buttons=[...document.querySelectorAll('button,[role=button]')];",
      "const images=[...document.querySelectorAll('img')];",
      "const hasName = e => Boolean((e.getAttribute('aria-label')||'').trim() ||",
      "(e.getAttribute('aria-labelledby')||'').trim() ||",
      "(e.getAttribute('title')||'').trim() ||",
      "(e.innerText||e.textContent||'').trim());",
      "const nav=performance.getEntriesByType('navigation')[0];",
      "return { url: location.origin+location.pathname,",
      "viewport: {width:innerWidth,height:innerHeight,documentWidth:document.documentElement.scrollWidth},",
      "horizontalOverflow:document.documentElement.scrollWidth>innerWidth+1,",
      "missingImageAlt:images.filter(e=>!e.hasAttribute('alt')).length,",
      "unlabeledInputs:inputs.filter(e=>!(e.labels&&e.labels.length)&&!hasName(e)).length,",
      "unlabeledButtons:buttons.filter(e=>!hasName(e)).length,",
      "navigationTiming:nav ? {",
      "dnsMs:Math.round(nav.domainLookupEnd-nav.domainLookupStart),",
      "connectMs:Math.round(nav.connectEnd-nav.connectStart),",
      "responseMs:Math.round(nav.responseEnd-nav.responseStart),",
      "domContentLoadedMs:Math.round(nav.domContentLoadedEventEnd),",
      "loadMs:Math.round(nav.loadEventEnd)",
      "} : null }; })()"
    ].join("");
    const result = await this.send("Runtime.evaluate", { expression, returnByValue: true });
    if (result?.exceptionDetails) throw new Error("Browser audit failed");
    return result.result.value;
  }

  public async close(): Promise<BrowserCloseResult> {
    const wasAttached = this.attachedPort !== null;
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

    this.attachedPort = null;
    this.activeTargetId = null;
    this.eventListeners.clear();
    this.consoleLogs = [];
    this.networkRequests = [];
    this.hasErrors = false;
    return { ok: true, message: wasAttached ? "Detached from Chrome; user browser remains running" : "Headless browser closed" };
  }
}

export const browserManager = new BrowserManager();
