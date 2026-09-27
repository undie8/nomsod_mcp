import http from "node:http";
import { URL } from "node:url";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { RemoteComputerHub } from "./hub-client.js";
import { getNomsodVersion } from "../shared/version.js";
import { createNomsodMcpHandler } from "./mcp.js";

const host = "127.0.0.1";
const port = Number(process.env.NOMSOD_INTERNAL_PORT || 3220);
const controlBase = process.env.NOMSOD_CONTROL_URL || "http://127.0.0.1:3221";
const controlKey = process.env.NOMSOD_CONTROL_KEY || "";
const version = getNomsodVersion(process.cwd());

if (!controlKey) {
  console.error("[runtime] NOMSOD_CONTROL_KEY is required.");
  process.exit(2);
}

const hub = new RemoteComputerHub(controlBase, controlKey);
const mcp = createNomsodMcpHandler(hub);
const mcpNodeHandler = toNodeHandler(mcp, {
  onerror: error => console.error("[runtime] MCP adapter error:", error)
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

  if (url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify({
      ok: true,
      service: "nomsod-runtime",
      version,
      pid: process.pid
    }));
    return;
  }

  if (url.pathname === "/mcp") {
    await mcpNodeHandler(req, res);
    return;
  }

  res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ error: "not_found" }));
});

server.keepAliveTimeout = 65_000;
server.headersTimeout = 70_000;
server.requestTimeout = 310_000;

server.listen(port, host, () => {
  console.log(`[runtime] listening on http://${host}:${port}`);
});

function exitWhenParentDisconnects(label: string): void {
  if (!process.connected) return;

  process.once("disconnect", () => {
    console.warn(`[${label}] parent IPC disconnected; exiting to avoid orphan process`);

    const forceTimer = setTimeout(() => process.exit(0), 2_000);
    forceTimer.unref();

    server.close(() => process.exit(0));
  });
}

exitWhenParentDisconnects("runtime");

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
