# Nomsod MCP

Nomsod MCP is a cross-platform remote-computer MCP bridge designed for ChatGPT.

The project is intended to replace separate Windows/macOS connectors with one architecture that can run on Windows, macOS, or Linux without hardcoded computer names and without any 9Router dependency.

## Core architecture

```text
ChatGPT
   |
   | OAuth 2.0 Authorization Code + PKCE
   | Streamable HTTP (stateless)
   v
+--------------------------------------------------+
| Nomsod Supervisor                               |
| long-lived control plane                        |
|                                                  |
|  OAuth store / device registry / Agent hub      |
|  public MCP socket / release manager            |
+----------------------+---------------------------+
                       |
              blue/green MCP runtime
                       |
              +--------+--------+
              |                 |
        Gateway Runtime A  Gateway Runtime B
              |
              | authenticated outbound WebSocket
              v
+--------------------------------------------------+
| Agent Guardian on each computer                 |
| long-lived device connection                    |
+----------------------+---------------------------+
                       |
              blue/green action runtime
                       |
              +--------+--------+
              |                 |
        Action Worker A     Action Worker B
```

A computer creates its own persistent device ID at runtime. Its display name defaults to the OS hostname and can optionally be overridden with `NOMSOD_DEVICE_NAME`. Source code contains no machine-specific names.

## Reliability model

Nomsod deliberately separates long-lived connection processes from code that changes frequently.

### Nomsod Supervisor

The Supervisor owns:

- the public HTTP/MCP socket
- OAuth discovery, authorization, and token exchange
- persistent OAuth/token state
- the device registry
- Agent WebSocket connections
- Gateway Runtime lifecycle
- known-good release state

The Supervisor is intentionally small. Ordinary self-repair should not modify or restart it.

### Gateway Runtime

The Gateway Runtime contains the MCP tool surface and forwards computer actions through the Supervisor's localhost-only control API.

A Gateway self-update performs:

1. `npm run typecheck`
2. creates an immutable source snapshot under `data/releases/<release-id>`
3. compiles that snapshot to JavaScript
4. starts the candidate Runtime on the inactive internal port
5. checks candidate health
6. routes new MCP requests to the candidate
7. drains in-flight requests on the old Runtime
8. stops the old Runtime

If typecheck, snapshot compilation, or health check fails, the current Runtime remains active.

`reload_runtime` performs this cut-over. `rollback_runtime` returns to the previous known-good release.

If the active Runtime crashes, the Supervisor automatically restarts the last-known-good compiled release.

### Agent Guardian

Each managed computer runs a long-lived Agent Guardian. The Guardian owns:

- the outbound WebSocket connection to the Supervisor
- persistent device identity and token
- heartbeat / ping-pong / reconnect state
- Action Worker lifecycle
- local Guardian health endpoint

The Guardian does not execute normal shell/file actions itself.

### Action Worker

The replaceable Action Worker executes computer actions such as filesystem and shell operations.

It uses the same known-good pattern as the Gateway Runtime:

- typecheck before release
- immutable compiled snapshots under `data/agent-releases/<release-id>`
- blue/green ports
- health check before cut-over
- in-flight draining
- rollback
- automatic restart after worker crash

This means Nomsod can repair action code while the Guardian keeps the computer online in ChatGPT.

Use `reload_device_runtime` and `rollback_device_runtime` for a selected computer.

## Parent-liveness and orphan prevention

Gateway Runtimes and Action Workers are direct Node child processes connected to their parent with an IPC channel.

If the Supervisor or Agent Guardian is hard-killed, Windows/macOS closes the IPC channel. The child detects the disconnect, closes its local server, and exits.

This prevents orphan Runtime/Worker processes from holding internal ports and causing `EADDRINUSE` restart loops.

## Connection resilience

### ChatGPT -> Nomsod

Nomsod uses stateless Streamable HTTP instead of depending on one permanently open legacy SSE MCP session.

OAuth access/refresh token hashes are persisted under `data/oauth.json`. Replacing a Gateway Runtime therefore does not invalidate ChatGPT authorization.

### Agent -> Supervisor

Agents connect outbound and use:

- heartbeat every 15 seconds by default
- WebSocket ping/pong
- stale-connection detection
- exponential reconnect backoff
- persistent device identity
- a persistent per-device token after initial pairing
- DNS fallback to configurable `NOMSOD_DNS_SERVERS` when the OS resolver temporarily returns `ENOTFOUND` or `EAI_AGAIN`

System DNS remains the first choice. The fallback applies only to Agent-to-Gateway connection setup so stale negative DNS caching does not keep a device offline after a new MCP hostname is created.

If the public Gateway/network disappears temporarily, the Agent Guardian remains alive and reconnects automatically.

In an active-active installation, local and Tailscale peer `ws://` Gateway routes are primary. The public `wss://` Gateway is retained as a fallback and is parked while any primary route is healthy. This prevents one device from opening both public and peer sockets to the same Gateway node and repeatedly superseding its own connection.

## UTF-8 and code-editing safety

Nomsod treats text editing as UTF-8-safe by default.

Protections include:

- strict UTF-8 decoding
- refusal to silently edit UTF-16 or invalid legacy-byte files
- temporary-file write path
- SHA-256 compare-and-write protection
- bounded `read_text_range` responses with `totalLines`, `linesReturned`, and `complete`
- `patch_text_file` requiring an expected SHA-256 and exact occurrence counts
- Windows PowerShell commands sent with `-EncodedCommand`
- PowerShell input/output encoding forced to UTF-8
- `.editorconfig` and `.gitattributes` UTF-8/LF rules

These rules are designed to prevent Thai-text mojibake and accidental full-file overwrites after a partial read.

## MCP tools

Computer tools:

- `list_computers`
- `get_system_info`
- `list_directory`
- `read_text_file`
- `read_text_range`
- `patch_text_file`
- `write_text_file`
- `execute_command`

Per-device self-healing tools:

- `device_runtime_status`
- `reload_device_runtime`
- `rollback_device_runtime`

Gateway self-healing tools:

- `runtime_status`
- `reload_runtime`
- `rollback_runtime`

## Authentication

ChatGPT authenticates to the public Supervisor using OAuth Authorization Code + PKCE.

The owner key is used only on the authorization approval page; it is not accepted directly as an MCP bearer token.

A new computer uses the pairing token only for first registration. It then receives its own persistent device token.

## Configuration

Copy the template and configure it before production installation:

```powershell
Copy-Item .env.example .env
```

Important values are:

- `NOMSOD_PUBLIC_BASE_URL`: public HTTPS origin seen by ChatGPT
- `NOMSOD_OWNER_KEY`: long random owner authorization secret
- `NOMSOD_PAIRING_TOKEN`: separate first-pairing secret
- `NOMSOD_GATEWAY_WS`: public `wss://.../agent` endpoint used by computers

Do not commit `.env`.

Default local ports:

- public Supervisor: `3219`
- Gateway Runtime A: `3220`
- internal Supervisor control: `3221`
- Gateway Runtime B: `3222`
- Action Worker A: `3230`
- Action Worker B: `3231`
- Agent Guardian health: `3232`

Only the public Supervisor port should be exposed externally. Runtime, Worker, control, and Guardian-health ports bind to localhost.

## Development

```powershell
npm install
npm run typecheck
npm run build
npm test
```

Development start:

```powershell
npm start
npm run agent
```

Production bootstrap artifacts are compiled to `dist/`:

```powershell
npm run build
npm run start:built
npm run agent:built
```

## Windows auto-start

Nomsod uses Task Scheduler rather than running the computer Agent as LocalSystem.

The roles are intentionally different:

- Supervisor: boot task under LocalSystem
- Agent Guardian: current user's logon task so file/process access matches that user
- Watchdog: machine task that checks health and restarts unhealthy tasks

Validate without installing:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Mode Both -DryRun -NoStart
```

Install after `.env` is configured (run elevated PowerShell when installing Supervisor):

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install.ps1 -Mode Both
```

Status:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\status.ps1
```

Uninstall service tasks while preserving state and identity:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\uninstall.ps1 -Mode Both
```

## macOS auto-start

The default macOS installation uses per-user LaunchAgents so the Agent has the logged-in user's permissions.

If a stable Node executable is not already available, `scripts/macos/install.sh` uses `ensure-node.sh` to install a project-local portable Node runtime under `.runtime/`. The archive is downloaded from nodejs.org and its SHA-256 is verified against the official `SHASUMS256.txt` before extraction. The generated plist stores the absolute Node path, so launchd does not depend on shell profile PATH setup.

```sh
./scripts/macos/install.sh both
```

To run the Supervisor as a system LaunchDaemon instead:

```sh
./scripts/macos/install.sh both --system-supervisor
```

For `--system-supervisor`, use a stable Node installation accessible to root (for example a system/Homebrew Node path rather than a transient shell-only version-manager shim).

Status:

```sh
./scripts/macos/status.sh
```

Uninstall launch services while preserving Nomsod data and identity:

```sh
./scripts/macos/uninstall.sh both
```

## Logging

The compiled bootstraps load `.env` automatically and write UTF-8 logs under `data/logs/` by default.

Set `NOMSOD_LOG_DIR` to use a different log location.


## Versioned distribution and terminal installation

Nomsod MCP publishes separate Windows and macOS release packages at `mcp.nomsod.net`. Each release has a semantic version and SHA-256 digest. Versioned package URLs are immutable; `releases/latest/*.json` only points clients at the newest package.

This deployment is a **single-owner, single-cluster** network. The stable logical cluster ID is `nomsod-main-v1`; computers are disposable nodes inside that one network. Normal installation never creates another cluster.

This deployment uses **KKSM2 / KKS (Synology DS920+) as the permanent bootstrap authority**. The NAS stores the current Windows/macOS installers, both SHA-verified release archives, the stable `nomsod-main-v1` cluster identity, and the existing Cloudflare tunnel credential. Computers are disposable nodes; the NAS is the durable source used to create or recreate them.

The normal new-computer path therefore does **not** require another Nomsod computer to be online and does not require browsing the NAS share. KKSM2 exposes only a tokenized bootstrap path through the dedicated `install.nomsod.net` Cloudflare tunnel. The private NAS bundle remains the authority behind that endpoint.

Windows can install from a single PowerShell command:

```powershell
irm https://install.nomsod.net/bootstrap/<private-bootstrap-token>/windows.ps1 | iex
```

macOS can use the equivalent shell launcher:

```sh
curl -fsSL https://install.nomsod.net/bootstrap/<private-bootstrap-token>/macos.sh | sh
```

The private bootstrap token is a long-lived owner credential: keep the full URL private. Requests with an incorrect path return 404. The installer downloads the SHA-verified bundle from KKSM2, restores the same `nomsod-main-v1` cluster, and does not need GUNN, Mac, or `mcp.nomsod.net` to be online first. The SMB launchers remain available as a local fallback, and **Add new computer** remains an optional convenience when an existing Nomsod node is online.

Computer identity and display name are created at runtime; no machine name is hardcoded.

Default installation locations:

- Windows: `%LOCALAPPDATA%\Nomsod MCP`
- macOS: `~/Library/Application Support/Nomsod MCP`

The installed Control UI uses the Nomsod cat icon on the Windows notification area and macOS menu bar. It shows status, device identity, Gateway/MCP URL, version, restart controls, a confirmation-gated **Reveal keys** action, and optional **Add new computer** enrollment. The permanent bootstrap authority is the private NAS folder on KKSM2 rather than a user-managed recovery export. Quitting the Control UI does not stop the Supervisor or Agent.

### Runtime process names

Long-lived processes use role-specific names so Activity Monitor and Task Manager remain understandable:

- `Nomsod MCP Supervisor` — keeps the public Gateway runtime healthy.
- `Nomsod MCP Gateway` — serves MCP/OAuth and connected-device routing.
- `Nomsod MCP Agent` — maintains one computer's connection to the Gateway.
- `Nomsod MCP Worker` — executes file, shell and device actions behind the Agent.
- `Nomsod MCP Control` — macOS menu bar / Windows notification-area UI.

On macOS each long-lived role is installed as a lightweight background app bundle with the Nomsod cat icon. The menu bar shows the transparent cat icon together with the installed version. Updater and watchdog jobs are scheduled checks, not permanent long-lived role processes.

### Automatic updates

Each installation creates an updater that checks the platform-specific latest manifest every 60 seconds:

- `https://mcp.nomsod.net/releases/latest/windows.json`
- `https://mcp.nomsod.net/releases/latest/macos.json`

An update is applied only after its package SHA-256 matches the manifest. `.env`, device identity, `data/`, logs and the portable runtime are preserved. Windows and macOS packages are independent, so either platform can be released without replacing the other package.

Release distribution is federated across same-cluster Gateway peers over the Tailscale peer port. For `releases/latest/*.json` and installer scripts, a Gateway compares its local manifest with healthy peer manifests and serves the newest semantic version. If an immutable versioned archive is missing locally, the Gateway streams it from a same-cluster peer. Peer distribution requests are local-only, so federation cannot recurse into a proxy loop. This prevents a stale active-active node from handing a new computer an older installer or manifest.

Gateway nodes also maintain a local release mirror. Bootstrap synchronizes both platform manifests, installers and SHA-verified immutable archives before a new Gateway starts serving the public tunnel. The periodic updater reconciles this mirror even when the application version is already current, so a node that was temporarily offline eventually becomes self-sufficient again instead of depending indefinitely on another peer for release files.

### Publishing a release

Keep `VERSION`, `package.json` and `package-lock.json` on the same semantic version. Versioned artifacts are immutable: the publisher refuses to rebuild a version whose release directory already contains files.

On the Windows gateway that serves the public distribution, build and promote in one command:

```powershell
.\scripts\release\publish.ps1 -DistributionTarget (Join-Path $env:LOCALAPPDATA 'Nomsod MCP\data\distribution')
```

Promotion copies the immutable versioned artifacts first, then the installer scripts, and updates `releases/latest/*.json` last. This prevents clients from observing a latest manifest before the referenced archives are available. When a runtime distribution target is supplied, the publisher also performs a best-effort refresh of the KKSM2 NAS bootstrap authority so the NAS tracks the newest release automatically.

## Deliberate non-goals

Nomsod MCP does not connect to 9Router and does not route AI-model or image-generation traffic.

Image generation remains a ChatGPT capability. Nomsod MCP is the secure bridge between ChatGPT and connected computers.

## Reliability boundary

Gateway Runtime and Action Worker code can update, roll back, crash, and recover without intentionally dropping the long-lived Supervisor/Guardian connections.

The OS service/watchdog layer automatically restarts the long-lived processes if they fail. A Supervisor process failure, machine reboot, network outage, or host failure can still cause a brief transport interruption; the architecture is designed to recover automatically rather than require manual reconnection.
