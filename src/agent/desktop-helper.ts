import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type {
  DesktopClickParams,
  DesktopClickResult,
  DesktopCursorPositionResult,
  DesktopFocusWindowParams,
  DesktopFocusWindowResult,
  DesktopKeyPressParams,
  DesktopKeyPressResult,
  DesktopListWindowsParams,
  DesktopListWindowsResult,
  DesktopMouseMoveParams,
  DesktopMouseMoveResult,
  DesktopTypeParams,
  DesktopTypeResult,
  WindowInfo
} from "../shared/desktop-types.js";

const execFileAsync = promisify(execFile);

function findWindowsDesktopBinary(): string | undefined {
  const envPath = process.env.NOMSOD_DESKTOP_BIN;
  if (envPath && fs.existsSync(envPath)) return envPath;

  const root = process.cwd();
  const buildPath = path.join(root, "build", "windows", "NomsodDesktopWin.exe");
  if (fs.existsSync(buildPath)) return buildPath;

  const appData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const localInstall = path.join(appData, "Nomsod MCP", "NomsodDesktopWin.exe");
  if (fs.existsSync(localInstall)) return localInstall;

  // Search background directory for current release
  const bgDir = path.join(appData, "Nomsod MCP", "background");
  if (fs.existsSync(bgDir)) {
    try {
      const versions = fs.readdirSync(bgDir);
      for (const ver of versions.reverse()) {
        const candidate = path.join(bgDir, ver, "NomsodDesktopWin.exe");
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }

  return undefined;
}

async function runWindowsDesktopCommand(args: string[]): Promise<any> {
  const bin = findWindowsDesktopBinary();
  if (bin) {
    const { stdout } = await execFileAsync(bin, args, {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000
    });
    return JSON.parse(stdout.trim());
  }

  // Fallback to inline PowerShell with attached user desktop
  const csSourcePath = path.join(process.cwd(), "scripts", "windows", "NomsodDesktopWin.cs");
  if (!fs.existsSync(csSourcePath)) {
    throw new Error("Desktop automation binary and source not found.");
  }

  // Compile on the fly to temporary exe or run directly
  const tempExe = path.join(os.tmpdir(), "nomsod-desktop-fallback.exe");
  if (!fs.existsSync(tempExe)) {
    const csc = path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
      "csc.exe"
    );
    await execFileAsync(
      csc,
      [
        "/nologo",
        "/target:exe",
        "/optimize+",
        "/reference:System.dll",
        "/reference:System.Core.dll",
        "/reference:System.Drawing.dll",
        "/reference:System.Windows.Forms.dll",
        `/out:${tempExe}`,
        csSourcePath
      ],
      { windowsHide: true, timeout: 20_000 }
    );
  }

  const { stdout } = await execFileAsync(tempExe, args, {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000
  });
  return JSON.parse(stdout.trim());
}

async function runMacJxa(code: string): Promise<any> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-l", "JavaScript", "-e", code], {
    encoding: "utf8",
    timeout: 15_000
  });
  const trimmed = stdout.trim();
  return trimmed ? JSON.parse(trimmed) : { ok: true };
}

async function runMacAppleScript(script: string): Promise<string> {
  const { stdout } = await execFileAsync("/usr/bin/osascript", ["-e", script], {
    encoding: "utf8",
    timeout: 15_000
  });
  return stdout.trim();
}

function escapeAppleScriptString(str: string): string {
  return str.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

export async function desktopGetCursorPosition(): Promise<DesktopCursorPositionResult> {
  if (process.platform === "win32") {
    const res = await runWindowsDesktopCommand(["pos"]);
    return { ok: true, x: res.x, y: res.y };
  }

  if (process.platform === "darwin") {
    const code = `
      ObjC.import('CoreGraphics');
      var e = $.CGEventCreate(null);
      var loc = $.CGEventGetLocation(e);
      JSON.stringify({ ok: true, x: Math.round(loc.x), y: Math.round(loc.y) });
    `;
    return runMacJxa(code);
  }

  throw new Error(`desktopGetCursorPosition is not supported on platform: ${process.platform}`);
}

export async function desktopMouseMove(params: DesktopMouseMoveParams): Promise<DesktopMouseMoveResult> {
  const x = Math.round(params.x);
  const y = Math.round(params.y);

  if (process.platform === "win32") {
    const res = await runWindowsDesktopCommand(["move", String(x), String(y)]);
    return { ok: true, x: res.x, y: res.y };
  }

  if (process.platform === "darwin") {
    const code = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${x}, ${y});
      var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, 0);
      $.CGEventPost($.kCGHIDEventTap, move);
      JSON.stringify({ ok: true, x: ${x}, y: ${y} });
    `;
    return runMacJxa(code);
  }

  throw new Error(`desktopMouseMove is not supported on platform: ${process.platform}`);
}

export async function desktopClick(params: DesktopClickParams = {}): Promise<DesktopClickResult> {
  const button = params.button || "left";
  const double = Boolean(params.double);

  if (process.platform === "win32") {
    const args = ["click"];
    if (typeof params.x === "number" && typeof params.y === "number") {
      args.push(String(Math.round(params.x)), String(Math.round(params.y)), button, String(double));
    } else {
      args.push(button, String(double));
    }
    const res = await runWindowsDesktopCommand(args);
    return {
      ok: true,
      x: res.x,
      y: res.y,
      button: res.button,
      double: res.double
    };
  }

  if (process.platform === "darwin") {
    let x = params.x;
    let y = params.y;
    if (typeof x !== "number" || typeof y !== "number") {
      const pos = await desktopGetCursorPosition();
      x = pos.x;
      y = pos.y;
    }
    x = Math.round(x);
    y = Math.round(y);

    const code = `
      ObjC.import('CoreGraphics');
      var pt = $.CGPointMake(${x}, ${y});
      var move = $.CGEventCreateMouseEvent(null, $.kCGEventMouseMoved, pt, 0);
      $.CGEventPost($.kCGHIDEventTap, move);

      var btn = '${button}';
      var isDouble = ${double ? "true" : "false"};
      var downType = btn === 'right' ? $.kCGEventRightMouseDown : (btn === 'middle' ? $.kCGEventOtherMouseDown : $.kCGEventLeftMouseDown);
      var upType = btn === 'right' ? $.kCGEventRightMouseUp : (btn === 'middle' ? $.kCGEventOtherMouseUp : $.kCGEventLeftMouseUp);
      var mouseBtn = btn === 'middle' ? 2 : (btn === 'right' ? 1 : 0);

      var down = $.CGEventCreateMouseEvent(null, downType, pt, mouseBtn);
      var up = $.CGEventCreateMouseEvent(null, upType, pt, mouseBtn);

      if (isDouble) {
        $.CGEventSetIntegerValueField(down, $.kCGMouseEventClickState, 2);
        $.CGEventSetIntegerValueField(up, $.kCGMouseEventClickState, 2);
      }
      $.CGEventPost($.kCGHIDEventTap, down);
      $.CGEventPost($.kCGHIDEventTap, up);
      JSON.stringify({ ok: true, x: ${x}, y: ${y}, button: btn, double: isDouble });
    `;
    return runMacJxa(code);
  }

  throw new Error(`desktopClick is not supported on platform: ${process.platform}`);
}

export async function desktopType(params: DesktopTypeParams): Promise<DesktopTypeResult> {
  const text = params.text;
  if (!text) {
    return { ok: true, text: "", length: 0 };
  }

  if (process.platform === "win32") {
    const res = await runWindowsDesktopCommand(["type", text]);
    return { ok: true, text: res.text, length: res.length };
  }

  if (process.platform === "darwin") {
    // AppleScript keystroke natively supports Unicode characters and does not alter based on active keyboard layout
    const escaped = escapeAppleScriptString(text);
    const script = `tell application "System Events" to keystroke "${escaped}"`;
    await runMacAppleScript(script);
    return { ok: true, text, length: text.length };
  }

  throw new Error(`desktopType is not supported on platform: ${process.platform}`);
}

const MAC_KEY_CODES: Record<string, number> = {
  enter: 36,
  return: 36,
  tab: 48,
  space: 49,
  backspace: 51,
  delete: 51,
  escape: 53,
  esc: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  pageup: 116,
  pagedown: 121,
  home: 115,
  end: 119,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111
};

export async function desktopKeyPress(params: DesktopKeyPressParams): Promise<DesktopKeyPressResult> {
  const key = (params.key || "").trim();
  if (!key) {
    throw new Error("Key parameter is required for desktopKeyPress.");
  }
  const modifiers = params.modifiers || [];

  if (process.platform === "win32") {
    const modsStr = modifiers.join(",");
    const res = await runWindowsDesktopCommand(["key", key, modsStr]);
    return { ok: true, key: res.key, modifiers };
  }

  if (process.platform === "darwin") {
    const modMap: Record<string, string> = {
      ctrl: "control down",
      control: "control down",
      alt: "option down",
      option: "option down",
      shift: "shift down",
      cmd: "command down",
      meta: "command down",
      command: "command down"
    };

    const macModifiers = modifiers
      .map(m => modMap[m.toLowerCase()])
      .filter(Boolean);

    const usingClause = macModifiers.length > 0 ? ` using {${macModifiers.join(", ")}}` : "";
    const lowerKey = key.toLowerCase();
    const keyCode = MAC_KEY_CODES[lowerKey];

    let script = "";
    if (keyCode !== undefined) {
      script = `tell application "System Events" to key code ${keyCode}${usingClause}`;
    } else if (key.length === 1) {
      const escaped = escapeAppleScriptString(key.toLowerCase());
      script = `tell application "System Events" to keystroke "${escaped}"${usingClause}`;
    } else {
      throw new Error(`Unsupported key for macOS desktopKeyPress: "${key}"`);
    }

    await runMacAppleScript(script);
    return { ok: true, key, modifiers };
  }

  throw new Error(`desktopKeyPress is not supported on platform: ${process.platform}`);
}

export async function desktopListWindows(params: DesktopListWindowsParams = {}): Promise<DesktopListWindowsResult> {
  const filter = (params.filter || "").trim();

  if (process.platform === "win32") {
    const args = ["windows"];
    if (filter) args.push(filter);
    const res = await runWindowsDesktopCommand(args);
    return { ok: true, windows: res.windows || [] };
  }

  if (process.platform === "darwin") {
    try {
      const code = `
        var app = Application('System Events');
        var procs = app.processes.whose({ backgroundOnly: false })();
        var filter = '${escapeAppleScriptString(filter.toLowerCase())}';
        var res = [];
        for (var i = 0; i < procs.length; i++) {
          try {
            var p = procs[i];
            var pName = p.name();
            var pId = p.unixId();
            var ws = p.windows();
            for (var j = 0; j < ws.length; j++) {
              var w = ws[j];
              var title = w.name() || '';
              if (filter && !pName.toLowerCase().includes(filter) && !title.toLowerCase().includes(filter)) {
                continue;
              }
              var pos = w.position();
              var size = w.size();
              res.push({
                id: pId * 1000 + (j + 1),
                title: title,
                processName: pName,
                pid: pId,
                bounds: {
                  x: Math.round(pos[0] || 0),
                  y: Math.round(pos[1] || 0),
                  width: Math.round(size[0] || 0),
                  height: Math.round(size[1] || 0)
                }
              });
            }
          } catch (e) {}
        }
        JSON.stringify({ ok: true, windows: res });
      `;
      return await runMacJxa(code);
    } catch {
      return { ok: true, windows: [] };
    }
  }

  throw new Error(`desktopListWindows is not supported on platform: ${process.platform}`);
}

export async function desktopFocusWindow(params: DesktopFocusWindowParams): Promise<DesktopFocusWindowResult> {
  if (process.platform === "win32") {
    const args = ["focus"];
    if (params.id !== undefined) {
      args.push(String(params.id));
    } else if (params.title) {
      args.push(params.title);
      if (params.processName) args.push(params.processName);
    } else if (params.processName) {
      args.push("", params.processName);
    } else {
      throw new Error("Must provide id, title, or processName to focus a window.");
    }

    const res = await runWindowsDesktopCommand(args);
    return {
      ok: Boolean(res.ok),
      focused: Boolean(res.focused),
      window: res.window,
      error: res.error
    };
  }

  if (process.platform === "darwin") {
    if (params.processName) {
      const script = `tell application "${escapeAppleScriptString(params.processName)}" to activate`;
      await runMacAppleScript(script);
      return {
        ok: true,
        focused: true,
        window: { id: params.id || 0, title: params.title || "", processName: params.processName }
      };
    }

    if (params.title || params.id) {
      // Find matching window first
      const list = await desktopListWindows({ filter: params.title });
      const target = list.windows.find(w =>
        (params.id && w.id === params.id) ||
        (params.title && w.title.toLowerCase().includes(params.title.toLowerCase()))
      );

      if (!target) {
        return { ok: false, focused: false, error: "window not found" };
      }

      const script = target.pid
        ? `tell application "System Events" to set frontmost of first process whose unix id is ${target.pid} to true`
        : `tell application "${escapeAppleScriptString(target.processName)}" to activate`;

      await runMacAppleScript(script);
      return { ok: true, focused: true, window: target };
    }

    throw new Error("Must provide id, title, or processName to focus a window.");
  }

  throw new Error(`desktopFocusWindow is not supported on platform: ${process.platform}`);
}
