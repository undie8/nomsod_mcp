import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { serveDistribution } from "../src/supervisor/distribution.js";

const cleanup: Array<() => Promise<void>> = [];

async function listen(server: http.Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address() as AddressInfo;
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())));
  return `http://127.0.0.1:${address.port}`;
}

async function makeRoot(version: string, installer: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "nomsod-dist-test-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));

  const latest = path.join(root, "data", "distribution", "releases", "latest");
  const install = path.join(root, "data", "distribution", "install");
  await mkdir(latest, { recursive: true });
  await mkdir(install, { recursive: true });

  await writeFile(path.join(latest, "windows.json"), JSON.stringify({
    version,
    url: `https://mcp.nomsod.net/releases/${version}/nomsod-mcp-windows-${version}.zip`,
    sha256: "a".repeat(64)
  }));
  await writeFile(path.join(install, "windows.ps1"), installer);
  return root;
}

function peerServer(version: string, installer: string, artifact = "peer-artifact"): http.Server {
  return http.createServer((req, res) => {
    if (req.url === "/releases/latest/windows.json") {
      const body = Buffer.from(JSON.stringify({
        version,
        url: `https://mcp.nomsod.net/releases/${version}/nomsod-mcp-windows-${version}.zip`,
        sha256: "b".repeat(64)
      }));
      res.writeHead(200, {
        "content-type": "application/json",
        "content-length": String(body.length)
      });
      res.end(body);
      return;
    }

    if (req.url === "/install/windows.ps1") {
      const body = Buffer.from(installer);
      res.writeHead(200, {
        "content-type": "text/plain",
        "content-length": String(body.length)
      });
      res.end(body);
      return;
    }

    if (req.url === `/releases/${version}/nomsod-mcp-windows-${version}.zip`) {
      const body = Buffer.from(artifact);
      res.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(body.length)
      });
      res.end(body);
      return;
    }

    res.writeHead(404);
    res.end();
  });
}

async function distributionServer(root: string, peers: string[]): Promise<string> {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");
    if (await serveDistribution(req, res, url, root, async () => peers)) return;
    res.writeHead(404);
    res.end();
  });
  return listen(server);
}

afterEach(async () => {
  while (cleanup.length > 0) {
    const fn = cleanup.pop();
    if (fn) await fn();
  }
});

describe("federated distribution", () => {
  it("serves newer peer manifests, installers and missing immutable artifacts", async () => {
    const root = await makeRoot("0.4.4", "local-old");
    const peer = await listen(peerServer("0.4.5", "peer-new", "peer-zip"));
    const publicBase = await distributionServer(root, [peer]);

    const manifest = await (await fetch(publicBase + "/releases/latest/windows.json")).json() as { version: string };
    expect(manifest.version).toBe("0.4.5");

    const installer = await (await fetch(publicBase + "/install/windows.ps1")).text();
    expect(installer).toBe("peer-new");

    const artifact = await (
      await fetch(publicBase + "/releases/0.4.5/nomsod-mcp-windows-0.4.5.zip")
    ).text();
    expect(artifact).toBe("peer-zip");
  });

  it("keeps local files when the local manifest is newer", async () => {
    const root = await makeRoot("0.4.6", "local-new");
    const peer = await listen(peerServer("0.4.5", "peer-old"));
    const publicBase = await distributionServer(root, [peer]);

    const manifest = await (await fetch(publicBase + "/releases/latest/windows.json")).json() as { version: string };
    expect(manifest.version).toBe("0.4.6");

    const installer = await (await fetch(publicBase + "/install/windows.ps1")).text();
    expect(installer).toBe("local-new");
  });
});
