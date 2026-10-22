import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { expect, it } from "vitest";

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

async function until(check: () => boolean | Promise<boolean>, timeout = 10_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Guardian integration condition timed out");
}

it("routes commands across a wake pause and an actual dropped WebSocket without duplicate reconnects", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nomsod-recovery-"));
  const gateway = new WebSocketServer({ host: "127.0.0.1", port: 0, autoPong: false });
  await once(gateway, "listening");
  const port = (gateway.address() as net.AddressInfo).port;
  const healthPort = await freePort();
  const workerPort = await freePort();
  const sparePort = await freePort();
  let child: ChildProcess | undefined;
  let socket: WebSocket | undefined;
  let connections = 0;
  let responding = true;
  let diagnostics = "";
  const pending = new Map<string, (value: any) => void>();
  gateway.on("connection", ws => {
    connections++;
    socket = ws;
    ws.on("ping", data => { if (responding) ws.pong(data); });
    ws.on("message", raw => {
      const message = JSON.parse(raw.toString());
      if (message.type === "hello") ws.send(JSON.stringify({ type: "ready", deviceId: "test", hubId: "test-hub" }));
      if (message.type === "heartbeat" && responding) ws.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
      if (message.type === "response") pending.get(message.requestId)?.(message);
    });
  });
  async function command(marker: string): Promise<void> {
    const requestId = marker;
    const result = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Command response timed out")), 5000);
      pending.set(requestId, value => { clearTimeout(timer); pending.delete(requestId); resolve(value); });
    });
    socket!.send(JSON.stringify({ type: "request", requestId, method: "shell.exec", params: { command: "echo " + marker } }));
    expect((await result).result.stdout).toContain(marker);
  }
  try {
    // A minimal action-worker health fixture keeps this test focused on the real
    // Guardian, WebSocket lifecycle and JobManager shell request/response chain.
    const release = path.join(root, "data", "agent-releases", "fixture", "dist", "agent");
    await fs.mkdir(release, { recursive: true });
    await fs.writeFile(path.join(release, "worker-main.js"),
      `const http=require('node:http');const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end('{"ok":true}');});s.listen(Number(process.env.NOMSOD_AGENT_WORKER_PORT),'127.0.0.1');process.on('disconnect',()=>s.close(()=>process.exit()));`);
    await fs.writeFile(path.join(root, "data", "agent-runtime-state.json"), JSON.stringify({ lastGoodReleaseId: "fixture" }));
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("NOMSOD_")));
    child = spawn(process.execPath, ["--import", pathToFileURL(path.resolve("node_modules/tsx/dist/loader.mjs")).href,
      "--require", path.resolve("tests/fixtures/guardian-clock-jump.cjs"), process.env.NOMSOD_GUARDIAN_TEST_ENTRY || path.resolve("src/agent/main.ts")], {
      cwd: root, windowsHide: true, stdio: ["ignore", "pipe", "pipe", "ipc"], env: {
        ...env, NOMSOD_GATEWAY_PORT: String(port), NOMSOD_GATEWAY_WS_LIST: `ws://127.0.0.1:${port}/agent`,
        NOMSOD_PEER_PORT: "0", NOMSOD_IDENTITY_PATH: path.join(root, "identity.json"),
        NOMSOD_AGENT_GUARDIAN_HEALTH_PORT: String(healthPort), NOMSOD_HEARTBEAT_MS: "100",
        NOMSOD_AGENT_WORKER_PORT_A: String(workerPort), NOMSOD_AGENT_WORKER_PORT_B: String(sparePort)
      }
    });
    child.stdout!.on("data", data => { diagnostics += data.toString(); });
    child.stderr!.on("data", data => { diagnostics += data.toString(); });
    await until(async () => {
      try { return (await (await fetch(`http://127.0.0.1:${healthPort}/health`)).json() as any).gatewayConnected; }
      catch { return false; }
    });
    await command("before_pause");
    responding = false;
    const acknowledged = once(child, "message");
    child.send({ type: "advance-clock", ms: 120_000 });
    await acknowledged;
    await new Promise(resolve => setTimeout(resolve, 7000));
    expect(connections, diagnostics).toBe(1);
    responding = true;
    socket!.send(JSON.stringify({ type: "heartbeat", at: Date.now() }));
    await command("after_pause");
    socket!.terminate();
    await until(() => connections === 2);
    await until(() => diagnostics.split("connected and ready").length >= 3);
    await command("after_reconnect");
    expect(connections).toBe(2);
  } finally {
    if (child && child.exitCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
    for (const ws of gateway.clients) ws.terminate();
    await new Promise<void>(resolve => gateway.close(() => resolve()));
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("nomsod-recovery-")) {
      throw new Error("Unexpected temporary fixture directory");
    }
    await fs.rm(root, { recursive: true, force: true });
  }
}, 30_000);
