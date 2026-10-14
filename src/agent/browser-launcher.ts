import { spawn, exec, ChildProcess } from "node:child_process";
import { promises as fsp } from "node:fs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { promisify } from "node:util";

const execAsync = promisify(exec);

export interface BrowserLauncherOptions {
  browser?: "chrome" | "edge" | "chromium" | "any";
  executablePath?: string;
  extraArgs?: string[];
  startupTimeoutMs?: number;
  headless?: boolean;
}

export interface LaunchedBrowser {
  process: ChildProcess;
  pid: number;
  port: number;
  webSocketDebuggerUrl: string;
  userDataDir: string;
  close(): Promise<void>;
}

function getCandidatePaths(browser: "chrome" | "edge" | "chromium" | "any"): string[] {
  const platform = os.platform();
  const candidates: string[] = [];

  if (platform === "win32") {
    const pf = process.env["PROGRAMFILES"] || "C:\\Program Files";
    const pfX86 = process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)";
    const localAppData = process.env["LOCALAPPDATA"] || path.join(os.homedir(), "AppData", "Local");

    if (browser === "chrome" || browser === "any") {
      candidates.push(
        path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(pfX86, "Google", "Chrome", "Application", "chrome.exe"),
        path.join(localAppData, "Google", "Chrome", "Application", "chrome.exe")
      );
    }
    if (browser === "edge" || browser === "any") {
      candidates.push(
        path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(pfX86, "Microsoft", "Edge", "Application", "msedge.exe"),
        path.join(localAppData, "Microsoft", "Edge", "Application", "msedge.exe")
      );
    }
    if (browser === "chromium" || browser === "any") {
      candidates.push(
        path.join(localAppData, "Chromium", "Application", "chrome.exe"),
        path.join(pf, "Chromium", "Application", "chrome.exe")
      );
    }
  } else if (platform === "darwin") {
    const homeApps = path.join(os.homedir(), "Applications");
    if (browser === "chrome" || browser === "any") {
      candidates.push(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        path.join(homeApps, "Google Chrome.app/Contents/MacOS/Google Chrome")
      );
    }
    if (browser === "edge" || browser === "any") {
      candidates.push(
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        path.join(homeApps, "Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
      );
    }
    if (browser === "chromium" || browser === "any") {
      candidates.push(
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        path.join(homeApps, "Chromium.app/Contents/MacOS/Chromium")
      );
    }
  } else {
    if (browser === "chrome" || browser === "any") {
      candidates.push(
        "/usr/bin/google-chrome",
        "/usr/bin/google-chrome-stable",
        "/usr/local/bin/google-chrome"
      );
    }
    if (browser === "edge" || browser === "any") {
      candidates.push(
        "/usr/bin/microsoft-edge",
        "/usr/bin/microsoft-edge-stable"
      );
    }
    if (browser === "chromium" || browser === "any") {
      candidates.push(
        "/usr/bin/chromium",
        "/usr/bin/chromium-browser",
        "/snap/bin/chromium"
      );
    }
  }

  return candidates;
}

export async function locateBrowser(options: BrowserLauncherOptions = {}): Promise<string> {
  if (options.executablePath) {
    try {
      await fsp.access(options.executablePath, fs.constants.X_OK);
      return options.executablePath;
    } catch {
      throw new Error(`Provided browser executable not found or not executable: ${options.executablePath}`);
    }
  }

  const browserType = options.browser || "any";
  const candidates = getCandidatePaths(browserType);

  for (const candidate of candidates) {
    try {
      await fsp.access(candidate, fs.constants.F_OK);
      return candidate;
    } catch {}
  }

  const binaryNames =
    browserType === "chrome"
      ? ["google-chrome", "google-chrome-stable", "chrome"]
      : browserType === "edge"
      ? ["microsoft-edge", "msedge"]
      : browserType === "chromium"
      ? ["chromium", "chromium-browser"]
      : ["google-chrome", "google-chrome-stable", "microsoft-edge", "chromium", "chromium-browser", "chrome", "msedge"];

  for (const bin of binaryNames) {
    try {
      const cmd = os.platform() === "win32" ? `where ${bin}` : `which ${bin}`;
      const { stdout } = await execAsync(cmd);
      const resolved = stdout.trim().split(/\r?\n/)[0];
      if (resolved) {
        await fsp.access(resolved, fs.constants.F_OK);
        return resolved;
      }
    } catch {}
  }

  throw new Error(
    `No suitable browser executable found for type "${browserType}" on platform "${os.platform()}". Please install Chrome or Edge.`
  );
}

export async function launchBrowser(options: BrowserLauncherOptions = {}): Promise<LaunchedBrowser> {
  const executablePath = await locateBrowser(options);
  const userDataDir = path.join(os.tmpdir(), `nomsod-browser-profile-${crypto.randomUUID()}`);
  await fsp.mkdir(userDataDir, { recursive: true });

  const args = [
    options.headless !== false ? "--headless=new" : "",
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-default-apps",
    "--disable-extensions",
    "--disable-features=Translate",
    `--user-data-dir=${userDataDir}`,
    ...(options.extraArgs || [])
  ].filter(Boolean);

  const child = spawn(executablePath, args, {
    detached: false,
    stdio: ["ignore", "pipe", "pipe"]
  });

  if (!child.pid) {
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Failed to spawn browser process from ${executablePath}`);
  }

  const timeoutMs = options.startupTimeoutMs || 10000;
  const startTime = Date.now();
  const activePortFile = path.join(userDataDir, "DevToolsActivePort");

  let port = 0;
  let wsPath = "";

  while (Date.now() - startTime < timeoutMs) {
    if (child.exitCode !== null) {
      await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Browser process exited prematurely with code ${child.exitCode}`);
    }

    try {
      if (fs.existsSync(activePortFile)) {
        const content = await fsp.readFile(activePortFile, "utf8");
        const lines = content.trim().split(/\r?\n/);
        if (lines.length >= 2 && lines[0] && lines[1]) {
          const parsedPort = parseInt(lines[0], 10);
          if (!isNaN(parsedPort) && parsedPort > 0) {
            port = parsedPort;
            wsPath = lines[1];
            break;
          }
        }
      }
    } catch {}

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  if (!port) {
    await terminateProcess(child);
    await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    throw new Error(`Timed out after ${timeoutMs}ms waiting for browser DevTools port.`);
  }

  const webSocketDebuggerUrl = `ws://127.0.0.1:${port}${wsPath}`;

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await terminateProcess(child);
    } finally {
      await fsp.rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    }
  };

  return {
    process: child,
    pid: child.pid,
    port,
    webSocketDebuggerUrl,
    userDataDir,
    close
  };
}

async function terminateProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || !child.pid) return;

  if (os.platform() === "win32") {
    try {
      await execAsync(`taskkill /pid ${child.pid} /t /f`);
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  } else {
    try {
      child.kill("SIGTERM");
      const exited = await Promise.race([
        new Promise((resolve) => child.on("exit", () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 2000))
      ]);
      if (!exited && child.exitCode === null) {
        child.kill("SIGKILL");
      }
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}
