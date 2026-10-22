// Verify the running release without exposing control keys or issuing new tokens.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const root = path.resolve(process.argv[2]);
const output = process.argv[3];
const environment = await readFile(path.join(root, ".env"), "utf8");
const configured = name => environment.match(new RegExp(`^${name}=["']?(\\d+)`, "m"))?.[1];
const gatewayPort = Number(configured("NOMSOD_GATEWAY_PORT") || 3219);
const controlPort = Number(configured("NOMSOD_CONTROL_PORT") || gatewayPort + 2);
const key = (await readFile(path.join(root, "data/control.key"), "utf8")).trim();
async function control(endpoint) {
  const response = await fetch(`http://127.0.0.1:${controlPort}${endpoint}`, {
    headers: { "x-nomsod-control-key": key }, signal: AbortSignal.timeout(10_000)
  });
  assert.equal(response.status, 200);
  return response.json();
}
const runtime = await control("/runtime");
assert.equal(runtime.active.alive, true);
const snapshot = path.join(root, "data/releases", runtime.active.id);
const version = JSON.parse(await readFile(path.join(snapshot, "package.json"), "utf8")).version;
assert.equal(version, "0.4.25");
const expectedHashes = {
  "dist/gateway/mcp.js": "ef48e348cc510eeaf2fec69b30561f594f9a6d8ccb037ab507b9e0af8750bb31",
  "dist/gateway/main.js": "c74011163b173532915bebfe5d95aedc6da31dd86fb5870f00cda039577edecb"
};
for (const [file, expected] of Object.entries(expectedHashes)) {
  const digest = createHash("sha256").update(await readFile(path.join(snapshot, file))).digest("hex");
  assert.equal(digest, expected, `Active snapshot mismatch: ${file}`);
}
const sdk = JSON.parse(await readFile(path.join(root, "node_modules/@modelcontextprotocol/server/package.json"), "utf8")).version;
assert.equal(sdk, "2.3.1");
const base = `http://127.0.0.1:${runtime.active.port}/mcp`;
async function rpc(method, params) {
  const response = await fetch(base, {
    method: "POST", signal: AbortSignal.timeout(35_000),
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 7, method, params })
  });
  const text = await response.text();
  const line = text.split(/\r?\n/).find(value => value.startsWith("data: "));
  return { status: response.status, body: JSON.parse(line ? line.slice(6) : text) };
}
async function tool(name, args) {
  const result = await rpc("tools/call", { name, arguments: args });
  assert.equal(result.status, 200);
  assert.ok(!result.body.error && !result.body.result.isError, JSON.stringify(result.body));
  return JSON.parse(result.body.result.content[0].text);
}
for (const authorization of [undefined, "Bearer invalid-deployment-probe"]) {
  const response = await fetch(`http://127.0.0.1:${gatewayPort}/mcp`, {
    method: "POST", headers: { "content-type": "application/json", ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(response.status, 401);
  assert.ok(response.headers.get("www-authenticate"));
  await response.text();
}
const discovery = await rpc("tools/list", {});
assert.equal(discovery.status, 200);
assert.equal(discovery.body.result.tools.length, 43);
const { devices } = await control("/devices");
const targets = ["mac", "undie"].map(hostname => {
  const device = devices.find(device => device.online && device.hostname.toLowerCase() === hostname);
  assert.ok(device, `${hostname} must be online`);
  assert.equal(device.version, "0.4.25");
  return device;
});
const systems = await Promise.all(targets.map(device => tool("get_system_info", { deviceId: device.deviceId })));
const checks = [];
for (let index = 0; index < targets.length; index++) {
  const device = targets[index];
  assert.equal(systems[index].hostname, device.hostname);
  const args = { deviceId: device.deviceId };
  const file = await tool("read_text_file", { ...args, path: "VERSION" });
  assert.equal(file.content.trim(), "0.4.25");
  assert.match(file.sha256, /^[a-f0-9]{64}$/i);
  const files = await tool("list_directory", { ...args, path: "." });
  assert.ok(files.some(file => file.name === "VERSION"));
  const command = device.platform === "win32" ? "Write-Output 'NOMSOD_RELEASE_OK'" : "printf 'NOMSOD_RELEASE_OK\\n'";
  const shell = await tool("execute_command", { ...args, command, timeoutMs: 10_000 });
  assert.equal(shell.exitCode, 0);
  assert.ok(shell.stdout.includes("NOMSOD_RELEASE_OK"));
  const excessive = await rpc("tools/call", { name: "get_system_info", arguments: { ...args, padding: Array(10_001).fill(null) } });
  assert.equal(excessive.body.result.isError, true);
  let oversize = "413";
  try {
    const large = await rpc("tools/call", { name: "get_system_info", arguments: { ...args, padding: "x".repeat(2 * 1024 * 1024) } });
    assert.equal(large.status, 413);
  } catch (error) {
    assert.equal(process.platform, "darwin");
    assert.equal(error.cause?.code, "ECONNRESET");
    oversize = "connection-reset";
  }
  assert.equal((await tool("get_system_info", args)).hostname, device.hostname);
  checks.push({ hostname: device.hostname, version: device.version, system: true, files: true, shell: true, elementLimit: true, bodyLimit: oversize, subsequentRequest: true });
}
const npmCli = process.platform === "win32"
  ? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")
  : path.resolve(path.dirname(process.execPath), "../lib/node_modules/npm/bin/npm-cli.js");
const { stdout } = await promisify(execFile)(process.execPath, [npmCli, "audit", "--json"], { cwd: root, windowsHide: true, timeout: 60_000, maxBuffer: 1024 * 1024 });
const audit = JSON.parse(stdout).metadata.vulnerabilities;
assert.equal(audit.total, 0);
const state = JSON.parse(await readFile(path.join(root, "data/runtime-state.json"), "utf8"));
assert.ok(state.previousGoodReleaseId);
const receipt = { at: new Date().toISOString(), platform: process.platform, node: process.version, version, sdk, active: runtime.active, activeHashes: expectedHashes, rollbackAvailable: true, authRejections: [401, 401], toolCount: 43, devices: checks, audit };
if (output) {
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(receipt, null, 2) + "\n", "utf8");
}
console.log(JSON.stringify(receipt));
