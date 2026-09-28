# Nomsod MCP Architecture

## Single-cluster invariant

This installation has one logical Nomsod network for one owner. Its stable cluster identity is `nomsod-main-v1`. GUNN, Mac and future computers are replaceable nodes inside that one cluster; reinstalling or adding a computer must never create a second cluster.

The permanent bootstrap authority is **KKSM2 / KKS**, the Synology DS920+ NAS. It stores the private bootstrap bundle for `nomsod-main-v1`: current platform installers and manifests, SHA-verified immutable release archives, stable cluster credentials, and the existing public-tunnel credential. Nomsod computers are replaceable nodes; the NAS is outside that disposable fleet.

A fresh Windows or macOS computer can therefore install directly from the NAS share without any old Nomsod computer online. The NAS launcher feeds the existing cluster bootstrap bundle to the normal installer, which verifies the bundled release checksum and installs Gateway + Agent for `nomsod-main-v1`. It never generates a new cluster identity. The public bootstrap still fails closed when no enrollment token is present, while short-lived Control-generated enrollment remains an optional convenience path.

## Topology

```text
                         ChatGPT
                            |
                    OAuth 2.0 + PKCE
                    Streamable HTTP
                            |
                            v
+-----------------------------------------------------------+
| Supervisor (long-lived control plane)                    |
|                                                           |
| public socket | OAuth store | device registry | Agent hub |
| release state | Runtime router                            |
+---------------------------+-------------------------------+
                            |
                     localhost control
                            |
              +-------------+-------------+
              |                           |
       Gateway Runtime A           Gateway Runtime B
       immutable release           immutable release


        authenticated outbound WebSocket per computer
                            |
                            v
+-----------------------------------------------------------+
| Agent Guardian (long-lived per-device control plane)     |
|                                                           |
| identity | reconnect | heartbeat | Worker lifecycle      |
+---------------------------+-------------------------------+
                            |
              +-------------+-------------+
              |                           |
        Action Worker A             Action Worker B
        immutable release           immutable release
```

## Process boundaries

### Supervisor

The Supervisor owns connection continuity on the server side.

Responsibilities:

- public HTTP endpoint
- OAuth discovery, authorization, and token exchange
- persistent OAuth token hashes
- device registry
- Agent WebSocket hub
- localhost-only Runtime control API
- Gateway Runtime release management
- blue/green cut-over and rollback

It is intentionally small and should not be part of ordinary self-repair edits.

### Gateway Runtime

The Gateway Runtime is a replaceable MCP data plane.

Responsibilities:

- MCP tool definitions and schemas
- request validation
- forwarding computer operations to the Supervisor control API

Each known-good release is an immutable source + compiled-JavaScript snapshot under `data/releases/`.

### Agent Guardian

The Agent Guardian owns connection continuity on a managed computer.

Responsibilities:

- runtime-created device identity
- OS-hostname-derived display name unless overridden
- persistent device token
- outbound WebSocket
- heartbeat, stale detection, and reconnect
- local Guardian health endpoint
- Action Worker lifecycle and release state

The Guardian does not execute ordinary file or shell actions.

### Action Worker

The Action Worker is the replaceable per-computer action data plane.

Responsibilities:

- system information
- strict UTF-8 file reads
- bounded text reads
- hash-guarded patch/write operations
- shell execution

Known-good worker releases are immutable source + compiled snapshots under `data/agent-releases/`.

## Release pipeline

Both replaceable planes follow the same principles:

1. typecheck the workspace
2. copy source and build configuration into a uniquely named release directory
3. compile that release independently to JavaScript
4. start the candidate on the inactive localhost port
5. verify `/health`
6. atomically change the active routing pointer
7. drain in-flight work on the previous release
8. stop the previous child
9. persist the new known-good release ID

A failed candidate never replaces the active release.

Rollback starts the previous known-good snapshot as a health-checked candidate and uses the same cut-over procedure.

## Parent-liveness IPC

Supervisor -> Gateway Runtime and Guardian -> Action Worker use Node child-process IPC.

The child exits when its parent IPC channel disappears. This matters especially on Windows, where a hard-killed parent can otherwise leave a child process holding a localhost port.

This invariant prevents stale orphan children from creating `EADDRINUSE` restart loops.

## Transport behavior

### ChatGPT transport

The public MCP endpoint is Streamable HTTP in stateless mode. Replacing an internal Runtime does not require replacing the public Supervisor socket.

OAuth state is persistent and independent of Runtime lifetime.

### Device transport

The Agent Guardian makes an outbound authenticated WebSocket connection to the Supervisor.

The Guardian uses heartbeat, ping/pong, stale detection, and exponential reconnect. Worker lifetime is independent from WebSocket lifetime.

### Release distribution transport

Each Supervisor exposes its local distribution tree on the public socket and, read-only, on the Tailscale peer socket. Public distribution requests may consult healthy same-cluster peer sockets. `releases/latest/*.json` and installer scripts follow the highest semantic version available in the cluster; missing immutable archives are streamed from a peer. Peer-socket distribution handling is local-only, which prevents recursive proxy loops.

This means an active-active node may be behind on its local `data/distribution` mirror without serving stale bootstrap material to a new computer, as long as another healthy node in the same cluster has the release. Bootstrap and the periodic updater additionally reconcile the local mirror in artifact-first / manifest-last order, validating SHA-256 before promotion. Mirror reconciliation runs even when no application update is needed, so temporary staleness heals automatically.

## OS lifecycle

### Windows

- Supervisor: Task Scheduler boot task under LocalSystem
- Agent Guardian: Task Scheduler logon task under the interactive user
- Watchdog: periodic machine task checking local health endpoints
- Task Scheduler restart-on-failure is also enabled

Running the Agent as the interactive user preserves the filesystem/profile/process semantics expected for code work.

### macOS

- Agent Guardian: per-user LaunchAgent
- Supervisor: per-user LaunchAgent by default
- optional Supervisor LaunchDaemon with `--system-supervisor`
- `KeepAlive` and a periodic health watchdog provide automatic restart

## Failure behavior

| Failure | Behavior |
|---|---|
| ChatGPT request reaches a bad source edit | typecheck blocks release creation |
| Candidate compiles but fails health | active release remains unchanged |
| Gateway Runtime crashes | Supervisor restarts last-known-good Runtime |
| Gateway functional regression | `rollback_runtime` restores previous release |
| Action Worker crashes | Guardian restarts last-known-good Worker; computer remains online |
| Action Worker functional regression | `rollback_device_runtime` restores previous Worker |
| Agent WebSocket drops | Guardian reconnects automatically |
| Supervisor/Guardian is hard-killed | IPC causes children to exit; OS task/launchd restarts the parent |
| Supervisor restarts | OAuth/device state persists; Agents reconnect |
| One Gateway has stale/missing distribution files | public distribution resolves the newest same-cluster peer manifest and proxies missing immutable artifacts |
| Every Nomsod machine is wiped/unavailable | install `nomsod-main-v1` directly from the private KKSM2 NAS bootstrap authority; no old node is required |
| Machine/network is unavailable | transport is interrupted until infrastructure returns |

## Text-editing invariant

Text-edit actions accept UTF-8 only unless explicit conversion support is added later.

Existing files require a matching expected SHA-256 before overwrite. Large files should be inspected with bounded reads and changed using exact replacements rather than reconstructed from a partial response.

Windows PowerShell commands use Unicode-safe encoded invocation so Thai text does not depend on the active console code page.

## Exposure boundary

Only the public Supervisor endpoint should be exposed through HTTPS.

The following remain localhost-only:

- Gateway Runtime A/B
- Supervisor internal control API
- Action Worker A/B
- Agent Guardian health endpoint

No Nomsod component depends on 9Router.
