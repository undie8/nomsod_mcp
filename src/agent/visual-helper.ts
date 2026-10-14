import crypto from "node:crypto";
import { execFile, execSync } from "node:child_process";
import fs from "node:fs";
import { promises as fsp } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ImageResult, ScreenshotParams, ScreenshotResult } from "../shared/visual-types.js";

const execFileAsync = promisify(execFile);

const SUPPORTED_EXTENSIONS: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml"
};

const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB limit

function parseImageDimensions(buffer: Buffer, ext: string): { width?: number; height?: number } {
  try {
    if (ext === ".png" && buffer.length >= 24) {
      if (buffer.toString("ascii", 12, 16) === "IHDR") {
        return {
          width: buffer.readUInt32BE(16),
          height: buffer.readUInt32BE(20)
        };
      }
    } else if ((ext === ".jpg" || ext === ".jpeg") && buffer.length > 4) {
      let offset = 2;
      while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) break;
        const marker = buffer[offset + 1];
        if (marker >= 0xc0 && marker <= 0xc2 && offset + 9 < buffer.length) {
          return {
            height: buffer.readUInt16BE(offset + 5),
            width: buffer.readUInt16BE(offset + 7)
          };
        }
        const length = buffer.readUInt16BE(offset + 2);
        offset += 2 + length;
      }
    } else if (ext === ".gif" && buffer.length >= 10) {
      return {
        width: buffer.readUInt16LE(6),
        height: buffer.readUInt16LE(8)
      };
    } else if (ext === ".svg") {
      const svgStr = buffer.toString("utf8", 0, Math.min(buffer.length, 2048));
      const widthMatch = svgStr.match(/width=["'](\d+(?:\.\d+)?)(?:px)?["']/i);
      const heightMatch = svgStr.match(/height=["'](\d+(?:\.\d+)?)(?:px)?["']/i);
      return {
        width: widthMatch ? parseFloat(widthMatch[1]) : undefined,
        height: heightMatch ? parseFloat(heightMatch[1]) : undefined
      };
    }
  } catch {
    // Best-effort dimensions
  }
  return {};
}

export async function readImageFile(filePath: string): Promise<ImageResult> {
  const resolvedPath = path.resolve(filePath);

  let stat;
  try {
    stat = await fsp.stat(resolvedPath);
  } catch {
    throw new Error(`Image file not found: ${resolvedPath}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Path is not a regular file: ${resolvedPath}`);
  }

  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image exceeds maximum allowed size of 10MB (${stat.size} bytes): ${resolvedPath}`);
  }

  const ext = path.extname(resolvedPath).toLowerCase();
  const mimeType = SUPPORTED_EXTENSIONS[ext];
  if (!mimeType) {
    throw new Error(
      `Unsupported image extension "${ext}". Supported: ${Object.keys(SUPPORTED_EXTENSIONS).join(", ")}`
    );
  }

  const buffer = await fsp.readFile(resolvedPath);
  const base64 = buffer.toString("base64");
  const dimensions = parseImageDimensions(buffer, ext);

  return {
    base64,
    mimeType,
    bytes: stat.size,
    ...dimensions
  };
}

export async function captureScreenshot(params: ScreenshotParams = {}): Promise<ScreenshotResult> {
  const tempId = crypto.randomBytes(6).toString("hex");
  const tempPath = path.join(os.tmpdir(), `nomsod-screenshot-${tempId}.png`);
  const screenMode = params.screenMode || "primary";

  try {
    if (process.platform === "win32") {
      const psScript = `
        Add-Type -AssemblyName System.Drawing, System.Windows.Forms
        $bounds = if ('${screenMode}' -eq 'virtual') {
          [System.Windows.Forms.SystemInformation]::VirtualScreen
        } else {
          [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
        }
        $bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
        $gfx = [System.Drawing.Graphics]::FromImage($bmp)
        $gfx.CopyFromScreen($bounds.X, $bounds.Y, 0, 0, $bounds.Size)
        $bmp.Save('${tempPath.replace(/\\/g, "\\\\")}', [System.Drawing.Imaging.ImageFormat]::Png)
        $gfx.Dispose()
        $bmp.Dispose()
      `;
      const encoded = Buffer.from(psScript, "utf16le").toString("base64");
      await execFileAsync("powershell.exe", [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-WindowStyle",
        "Hidden",
        "-EncodedCommand",
        encoded
      ], {
        timeout: 15_000,
        windowsHide: true
      });
    } else if (process.platform === "darwin") {
      await execFileAsync("/usr/sbin/screencapture", ["-x", tempPath], { timeout: 15_000 });
    } else if (process.platform === "linux") {
      const hasDisplay = process.env.DISPLAY || process.env.WAYLAND_DISPLAY;
      if (!hasDisplay) {
        throw new Error("Linux screenshot failed: No display server found (DISPLAY/WAYLAND_DISPLAY not set).");
      }
      let captured = false;
      if (process.env.WAYLAND_DISPLAY) {
        try {
          execSync(`grim "${tempPath}"`, { stdio: "ignore", timeout: 10_000 });
          captured = true;
        } catch {}
      }
      if (!captured) {
        execSync(`import -window root "${tempPath}"`, { stdio: "ignore", timeout: 10_000 });
      }
    } else {
      throw new Error(`Screenshot capture is not supported on platform: ${process.platform}`);
    }

    if (!fs.existsSync(tempPath)) {
      throw new Error("Screenshot capture failed: image file was not generated.");
    }

    const image = await readImageFile(tempPath);
    return {
      ...image,
      capturedAt: Date.now()
    };
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        await fsp.unlink(tempPath);
      }
    } catch {}
  }
}
