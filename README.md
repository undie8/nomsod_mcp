# Nomsod MCP

Nomsod MCP is a cross-platform remote-computer MCP bridge designed for ChatGPT.

It is intended to replace the separate Chanom/Mali pattern with one architecture that can run on Windows, macOS, or Linux without hardcoded machine names.

## Core design

```text
ChatGPT
   |
   | OAuth 2.0 + PKCE
   v
Nomsod Supervisor
   |-- persistent OAuth/token store
   |-- device registry
   |-- Agent WebSocket connections
   |-- Runtime blue/green router
   |
   +--> Runtime A  <----> Runtime B
   |
   +--> Agent: any Windows/macOS/Linux computer
```

The machine name is discovered at runtime from the OS hostname. A user may optionally set `NOMSOD_DEVICE_NAME`, but no source code contains machine-specific names such as GUNN, MATH, or MacBook.

## Why the Supervisor exists

The Supervisor is intentionally small and stable. It owns the public socket, OAuth state, device connections, and last-known-good Runtime state.

The Runtime contains MCP tools and can be replaced while the Supervisor stays alive.

A self-update uses:

1. `npm run typecheck`
2. snapshot current source into `data/releases/<release-id>`
3. start the candidate Runtime on the inactive internal port
4. health-check the candidate
5. switch new MCP requests to the candidate
6. let in-flight requests finish on the old Runtime
7. stop the old Runtime

If the candidate fails typecheck or health check, traffic remains on the current Runtime.

If the active Runtime crashes, the Supervisor automatically restarts the last-known-good release.

`rollback_runtime` switches back to the previous known-good snapshot with the same blue/green mechanism.

## Connection resilience

### ChatGPT -> MCP

Nomsod uses stateless Streamable HTTP rather than a permanently open legacy SSE MCP session.

OAuth access and refresh token hashes are persisted under `data/oauth.json`, so a Runtime restart does not invalidate ChatGPT authorization.

### Agent -> Supervisor

Agents connect outbound over WebSocket and use:

- heartbeat every 15 seconds by default
- WebSocket ping/pong
- stale-connection detection
- exponential reconnect backoff
- persistent device identity
- persistent per-device token after pairing

If the Gateway disappears temporarily, the Agent stays running and reconnects automatically.

## UTF-8 safety

Nomsod treats text editing as UTF-8-safe by default.

Protections include:

- strict UTF-8 decoding
- refusal to silently edit UTF-16 or invalid legacy-byte files
- atomic-ish temporary-file write path
- SHA-256 compare-and-write protection
- bounded `read_text_range` with `totalLines`, `linesReturned`, and `complete`
- `patch_text_file` requiring an expected SHA-256 and exact occurrence counts
- Windows PowerShell commands sent via `-EncodedCommand`
- PowerShell input/output encoding forced to UTF-8
- `.editorconfig` and `.gitattributes` UTF-8/LF rules

This is specifically intended to prevent Thai text mojibake and accidental full-file overwrites after a partial read.

## Current MCP tools

- `list_computers`
- `get_system_info`
- `list_directory`
- `read_text_file`
- `read_text_range`
- `patch_text_file`
- `write_text_file`
- `execute_command`
- `runtime_status`
- `reload_runtime`
- `rollback_runtime`

## Development

Install dependencies:

```powershell
npm install
```

Run typecheck:

```powershell
npm run typecheck
```

Start the Supervisor:

```powershell
npm start
```

Start an Agent:

```powershell
npm run agent
```

The default local ports are:

- public Supervisor: `3219`
- Runtime A: `3220`
- internal control: `3221`
- Runtime B: `3222`

For production, expose only the public Supervisor endpoint through HTTPS. Internal Runtime/control ports remain localhost-only.

## Authentication

ChatGPT authenticates to the Supervisor with OAuth Authorization Code + PKCE.

The owner key is used only on the authorization approval page. It is not accepted directly as an MCP bearer token.

Device Agents use a first-pairing token once, then receive their own persistent device token.

## Deliberate non-goals

Nomsod MCP does not connect to 9Router and does not route AI model or image-generation traffic.

Image generation remains a ChatGPT capability. Nomsod MCP only provides access to connected computers.

## Reliability boundary

Runtime code can update, roll back, and recover without dropping Agent connections or the public Supervisor.

No software can guarantee zero interruption if the Supervisor process itself, the OS, the network, or the host machine fails. The production plan is to keep the Supervisor minimal and run it under an OS service/watchdog so Supervisor failure becomes an automatic brief reconnect rather than a manual recovery.
