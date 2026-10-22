// Run from the candidate root; keep the installed control key in memory only.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const installedRoot = path.resolve(process.argv[2]);
const reportFile = process.argv[3];
const environment = await readFile(path.join(installedRoot, ".env"), "utf8");
const configuredPort = name => environment.match(new RegExp(`^${name}=["']?(\\d+)`, "m"))?.[1];
const controlPort = configuredPort("NOMSOD_CONTROL_PORT") || Number(configuredPort("NOMSOD_GATEWAY_PORT") || 3219) + 2;
const key = (await readFile(path.join(installedRoot, "data/control.key"), "utf8")).trim();
const controlBase = `http://127.0.0.1:${controlPort}`;
const control = async endpoint => {
  const response = await fetch(`${controlBase}${endpoint}`, {
    headers: { "x-nomsod-control-key": key }, signal: AbortSignal.timeout(10_000)
  });
  assert.equal(response.status, 200);
  return response.json();
};
const { devices } = await control("/devices");
const targets = ["mac", "undie"].map(hostname => {
  const device = devices.find(device => device.online && device.hostname.toLowerCase() === hostname);
  assert.ok(device, `${hostname} must be online on this gateway`);
  return device;
});
const reservation = net.createServer();
reservation.listen(0, "127.0.0.1");
await once(reservation, "listening");
const port = reservation.address().port;
await new Promise(resolve => reservation.close(resolve));
const child = spawn(process.execPath, [path.resolve("dist/gateway/main.js")], {
  cwd: process.cwd(), windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NOMSOD_INTERNAL_PORT: String(port), NOMSOD_CONTROL_URL: controlBase, NOMSOD_CONTROL_KEY: key }
});
let diagnostics = "";
for (const stream of [child.stdout, child.stderr]) stream.on("data", data => {
  diagnostics = (diagnostics + data.toString()).slice(-8000);
});
const base = `http://127.0.0.1:${port}`;
async function rpc(method, params, id = 7) {
  const response = await fetch(`${base}/mcp`, {
    method: "POST", signal: AbortSignal.timeout(35_000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params })
  });
  const raw = await response.text();
  const line = raw.split(/\r?\n/).find(line => line.startsWith("data: "));
  return { status: response.status, message: JSON.parse(line ? line.slice(6) : raw) };
}
async function tool(name, args) {
  const reply = await rpc("tools/call", { name, arguments: args });
  assert.equal(reply.status, 200);
  assert.ok(!reply.message.error, JSON.stringify(reply.message.error));
  assert.ok(!reply.message.result.isError, JSON.stringify(reply.message.result));
  return JSON.parse(reply.message.result.content[0].text);
}
try {
  let healthy = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(child.exitCode, null, diagnostics);
    try { healthy = (await fetch(`${base}/health`)).ok; } catch {}
    if (healthy) break;
    await delay(100);
  }
  assert.ok(healthy, diagnostics);
  const discovery = await rpc("tools/list", {});
  assert.equal(discovery.status, 200);
  assert.ok(discovery.message.result.tools.length > 30);
  const systems = await Promise.all(targets.map(device => tool("get_system_info", { deviceId: device.deviceId })));
  const receipts = [];
  for (let index = 0; index < targets.length; index++) {
    const device = targets[index];
    assert.equal(systems[index].hostname, device.hostname);
    const args = { deviceId: device.deviceId };
    const files = await tool("list_directory", { ...args, path: "." });
    assert.ok(files.some(file => file.name === "VERSION"));
    const version = await tool("read_text_file", { ...args, path: "VERSION" });
    assert.match(version.sha256, /^[a-f0-9]{64}$/i);
    const shell = await tool("execute_command", {
      ...args, command: device.platform === "win32" ? "Write-Output 'NOMSOD_DEPENDENCY_PROBE_OK'" : "printf 'NOMSOD_DEPENDENCY_PROBE_OK\\n'", timeoutMs: 10_000
    });
    assert.equal(shell.exitCode, 0);
    assert.ok(shell.stdout.includes("NOMSOD_DEPENDENCY_PROBE_OK"));
    const runtime = await tool("device_runtime_status", args);
    const missingPath = await rpc("tools/call", { name: "read_text_file", arguments: args });
    assert.ok(missingPath.message.error || missingPath.message.result?.isError);
    const excessive = await rpc("tools/call", { name: "get_system_info", arguments: { ...args, padding: Array(10_001).fill(null) } });
    assert.equal(excessive.message.result.isError, true);
    let bodyRejection = "413";
    try {
      const large = await rpc("tools/call", { name: "get_system_info", arguments: { ...args, padding: "x".repeat(2 * 1024 * 1024) } });
      assert.equal(large.status, 413);
    } catch (error) {
      // Early connection close can race an in-flight upload on macOS.
      assert.equal(process.platform, "darwin");
      assert.equal(error.cause?.code, "ECONNRESET");
      bodyRejection = "connection-reset";
    }
    assert.equal((await tool("get_system_info", args)).hostname, device.hostname);
    receipts.push({ hostname: device.hostname, platform: device.platform, version: version.content.trim(), system: true, files: true, shell: true, invalidInput: true, elementLimit: true, bodyLimit: bodyRejection, recovered: true, runtime });
  }
  const receipt = { at: new Date().toISOString(), platform: process.platform, node: process.version, sdk: JSON.parse(await readFile("node_modules/@modelcontextprotocol/server/package.json", "utf8")).version, toolCount: discovery.message.result.tools.length, devices: receipts, supervisor: await control("/runtime") };
  if (reportFile) await writeFile(reportFile, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(receipt));
} finally {
  if (child.exitCode === null) {
    const stopped = once(child, "exit");
    child.kill();
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    await stopped;
    clearTimeout(timer);
  }
}
