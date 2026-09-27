import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { URL } from "node:url";

const contentTypes: Record<string, string> = {
  ".json": "application/json; charset=utf-8",
  ".ps1": "text/plain; charset=utf-8",
  ".sh": "text/plain; charset=utf-8",
  ".zip": "application/zip",
  ".gz": "application/gzip",
  ".tgz": "application/gzip",
  ".png": "image/png"
};

function safePath(baseDir: string, relative: string): string | undefined {
  const normalized = relative.replace(/^\/+/, "");
  const candidate = path.resolve(baseDir, normalized);
  const base = path.resolve(baseDir) + path.sep;
  if (candidate !== path.resolve(baseDir) && !candidate.startsWith(base)) return undefined;
  return candidate;
}

export async function serveDistribution(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string
): Promise<boolean> {
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  let relative: string | undefined;
  if (url.pathname.startsWith("/install/")) {
    relative = url.pathname.slice(1);
  } else if (url.pathname.startsWith("/releases/")) {
    relative = url.pathname.slice(1);
  } else {
    return false;
  }

  const baseDir = path.join(root, "data", "distribution");
  const file = safePath(baseDir, relative);
  if (!file) {
    res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "invalid_path" }));
    return true;
  }

  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not_file");

    const ext = file.endsWith(".tar.gz") ? ".gz" : path.extname(file).toLowerCase();
    const latest = url.pathname.startsWith("/releases/latest/") || url.pathname.startsWith("/install/");

    res.writeHead(200, {
      "content-type": contentTypes[ext] || "application/octet-stream",
      "content-length": String(info.size),
      "cache-control": latest
        ? "no-store, max-age=0"
        : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff"
    });

    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    createReadStream(file).pipe(res);
    return true;
  } catch {
    res.writeHead(404, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(JSON.stringify({ error: "release_not_found" }));
    return true;
  }
}
