import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import http from "node:http";
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

type PeerProvider = () => Promise<string[]>;

type ManifestCandidate = {
  source: "local" | string;
  version: string;
  body: Buffer;
};

function safePath(baseDir: string, relative: string): string | undefined {
  const normalized = relative.replace(/^\/+/, "");
  const candidate = path.resolve(baseDir, normalized);
  const base = path.resolve(baseDir) + path.sep;
  if (candidate !== path.resolve(baseDir) && !candidate.startsWith(base)) return undefined;
  return candidate;
}

function versionTuple(value: string): [number, number, number] | undefined {
  const match = value.trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareVersions(a: string, b: string): number {
  const av = versionTuple(a);
  const bv = versionTuple(b);
  if (!av && !bv) return 0;
  if (!av) return -1;
  if (!bv) return 1;

  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function contentTypeFor(file: string): string {
  const ext = file.endsWith(".tar.gz") ? ".gz" : path.extname(file).toLowerCase();
  return contentTypes[ext] || "application/octet-stream";
}

function cacheControlFor(pathname: string): string {
  return pathname.startsWith("/releases/latest/") || pathname.startsWith("/install/")
    ? "no-store, max-age=0"
    : "public, max-age=31536000, immutable";
}

async function localFileExists(file: string): Promise<boolean> {
  try {
    const info = await stat(file);
    return info.isFile();
  } catch {
    return false;
  }
}

async function serveLocalFile(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  file: string
): Promise<boolean> {
  try {
    const info = await stat(file);
    if (!info.isFile()) return false;

    res.writeHead(200, {
      "content-type": contentTypeFor(file),
      "content-length": String(info.size),
      "cache-control": cacheControlFor(pathname),
      "x-content-type-options": "nosniff"
    });

    if (req.method === "HEAD") {
      res.end();
      return true;
    }

    createReadStream(file).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function sendBuffer(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  body: Buffer
): void {
  res.writeHead(200, {
    "content-type": contentTypeFor(pathname),
    "content-length": String(body.length),
    "cache-control": cacheControlFor(pathname),
    "x-content-type-options": "nosniff"
  });
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  res.end(body);
}

function peerBuffer(
  base: string,
  pathname: string,
  maxBytes = 2 * 1024 * 1024
): Promise<Buffer | undefined> {
  return new Promise(resolve => {
    let settled = false;
    const done = (value?: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const req = http.get(base + pathname, { timeout: 1_500 }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        done();
        return;
      }

      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", chunk => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buffer.length;
        if (size <= maxBytes) chunks.push(buffer);
      });
      res.on("end", () => {
        if (size > maxBytes) {
          done();
          return;
        }
        done(Buffer.concat(chunks));
      });
      res.on("error", () => done());
    });

    req.on("timeout", () => {
      req.destroy();
      done();
    });
    req.on("error", () => done());
  });
}

async function proxyPeerFile(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
  base: string
): Promise<boolean> {
  return new Promise(resolve => {
    let resolved = false;
    const finish = (value: boolean) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
    };

    const upstream = http.request(base + pathname, {
      method: req.method,
      timeout: 2_500
    }, upstreamRes => {
      if (upstreamRes.statusCode !== 200) {
        upstreamRes.resume();
        finish(false);
        return;
      }

      const headers: Record<string, string> = {
        "content-type": String(upstreamRes.headers["content-type"] || contentTypeFor(pathname)),
        "cache-control": cacheControlFor(pathname),
        "x-content-type-options": "nosniff"
      };
      const length = upstreamRes.headers["content-length"];
      if (length) headers["content-length"] = String(length);

      res.writeHead(200, headers);

      if (req.method === "HEAD") {
        upstreamRes.resume();
        res.end();
        finish(true);
        return;
      }

      upstreamRes.pipe(res);
      finish(true);
    });

    upstream.on("timeout", () => {
      upstream.destroy();
      finish(false);
    });
    upstream.on("error", () => finish(false));
    upstream.end();
  });
}

function parseManifestVersion(body: Buffer): string | undefined {
  try {
    const parsed = JSON.parse(body.toString("utf8"));
    if (
      typeof parsed?.version !== "string" ||
      typeof parsed?.url !== "string" ||
      typeof parsed?.sha256 !== "string"
    ) {
      return undefined;
    }
    return versionTuple(parsed.version) ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function manifestCandidates(
  baseDir: string,
  platform: "windows" | "macos",
  peers: string[]
): Promise<ManifestCandidate[]> {
  const pathname = "/releases/latest/" + platform + ".json";
  const localPath = safePath(baseDir, pathname.slice(1));
  const candidates: ManifestCandidate[] = [];

  if (localPath) {
    try {
      const body = await readFile(localPath);
      const version = parseManifestVersion(body);
      if (version) candidates.push({ source: "local", version, body });
    } catch {}
  }

  const peerBodies = await Promise.all(
    peers.map(async source => {
      const body = await peerBuffer(source, pathname, 256 * 1024);
      const version = body ? parseManifestVersion(body) : undefined;
      return body && version ? { source, version, body } : undefined;
    })
  );

  for (const candidate of peerBodies) {
    if (candidate) candidates.push(candidate);
  }

  candidates.sort((a, b) => compareVersions(b.version, a.version));
  return candidates;
}

function platformForInstall(pathname: string): "windows" | "macos" | undefined {
  if (pathname === "/install/windows.ps1") return "windows";
  if (pathname === "/install/macos.sh") return "macos";
  return undefined;
}

function platformForLatest(pathname: string): "windows" | "macos" | undefined {
  if (pathname === "/releases/latest/windows.json") return "windows";
  if (pathname === "/releases/latest/macos.json") return "macos";
  return undefined;
}

export async function serveDistribution(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  root: string,
  peerProvider?: PeerProvider
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

  const peers = peerProvider ? await peerProvider().catch(() => []) : [];
  const latestPlatform = platformForLatest(url.pathname);

  if (latestPlatform && peers.length > 0) {
    const candidates = await manifestCandidates(baseDir, latestPlatform, peers);
    if (candidates.length > 0) {
      sendBuffer(req, res, url.pathname, candidates[0].body);
      return true;
    }
  }

  const installPlatform = platformForInstall(url.pathname);
  if (installPlatform && peers.length > 0) {
    const candidates = await manifestCandidates(baseDir, installPlatform, peers);

    for (const candidate of candidates) {
      if (candidate.source === "local") {
        if (await serveLocalFile(req, res, url.pathname, file)) return true;
        continue;
      }

      const body = await peerBuffer(candidate.source, url.pathname, 2 * 1024 * 1024);
      if (body) {
        sendBuffer(req, res, url.pathname, body);
        return true;
      }
    }
  }

  if (await serveLocalFile(req, res, url.pathname, file)) return true;

  if (peers.length > 0) {
    for (const peer of peers) {
      if (await proxyPeerFile(req, res, url.pathname, peer)) return true;
    }
  }

  res.writeHead(404, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify({ error: "release_not_found" }));
  return true;
}
