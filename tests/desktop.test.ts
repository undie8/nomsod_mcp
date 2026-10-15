import { describe, expect, it } from "vitest";
import {
  desktopClick,
  desktopFocusWindow,
  desktopGetCursorPosition,
  desktopKeyPress,
  desktopListWindows,
  desktopMouseMove,
  desktopType
} from "../src/agent/desktop-helper.js";

describe("Desktop Automation Cross-Platform", () => {
  it("should retrieve cursor position without error", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const pos = await desktopGetCursorPosition();
    expect(pos.ok).toBe(true);
    expect(typeof pos.x).toBe("number");
    expect(typeof pos.y).toBe("number");
  });

  it("should move mouse and report new coordinates", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const current = await desktopGetCursorPosition();
    const targetX = current.x;
    const targetY = current.y;
    const result = await desktopMouseMove({ x: targetX, y: targetY });
    expect(result.ok).toBe(true);
    expect(result.x).toBe(targetX);
    expect(result.y).toBe(targetY);
  });

  it("should list active windows with titles, processes, and coordinates", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const result = await desktopListWindows();
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.windows)).toBe(true);
    expect(result.windows.length).toBeGreaterThan(0);

    const first = result.windows[0];
    expect(first).toBeDefined();
    expect(first.title).toBeDefined();
    expect(first.processName).toBeDefined();
    expect(first.bounds).toBeDefined();
    if (first.bounds) {
      expect(typeof first.bounds.width).toBe("number");
      expect(typeof first.bounds.height).toBe("number");
    }
  });

  it("should filter windows by title or process substring", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    // Filter for common processes or non-existent process
    const res = await desktopListWindows({ filter: "nonexistent_proc_xyz_9999" });
    expect(res.ok).toBe(true);
    expect(res.windows.length).toBe(0);
  });

  it("should simulate keypress without error", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const res = await desktopKeyPress({ key: "shift" });
    expect(res.ok).toBe(true);
    expect(res.key).toBe("shift");
  });

  it("should simulate layout-independent unicode typing", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    const testText = "NomsodTest";
    const res = await desktopType({ text: testText });
    expect(res.ok).toBe(true);
    expect(res.text).toBe(testText);
    expect(res.length).toBe(testText.length);
  });

  it("should handle focus window gracefully", async () => {
    if (process.platform !== "win32" && process.platform !== "darwin") {
      return;
    }
    // Attempting to focus a non-existent window should return focused: false without throwing
    const res = await desktopFocusWindow({ title: "nonexistent_proc_xyz_9999" });
    expect(res.ok).toBe(false);
    expect(res.focused).toBe(false);
  });
});
