# Architecture

## Process boundaries

### Supervisor

Long-lived, minimal control plane:

- public HTTP endpoint
- OAuth discovery/authorization/token exchange
- persistent token store
- device registry
- Agent WebSocket hub
- Runtime lifecycle manager
- release snapshots
- blue/green cut-over and rollback

The Supervisor should not normally be modified by self-repair operations.

### Runtime

Replaceable MCP data plane:

- MCP tool definitions
- validation
- forwarding tool calls to the Supervisor's localhost-only control API

Runtime releases are immutable snapshots under `data/releases/`.

### Agent

Runs on each managed computer:

- creates a device ID at runtime
- derives display name from hostname unless overridden
- connects outbound to the Supervisor
- reconnects automatically
- executes supported local actions

## Failure behavior

| Failure | Expected behavior |
|---|---|
| Agent network drop | Agent reconnects automatically |
| Runtime crash | Supervisor restarts last-known-good Runtime |
| Bad source edit | typecheck blocks cut-over |
| Candidate starts but health fails | current Runtime remains active |
| Candidate has functional regression | `rollback_runtime` returns to previous release |
| Supervisor restart | OAuth/device state persists; Agents reconnect automatically |
| Host/OS/network failure | external service/watchdog is required |

## Encoding invariant

Text file actions are UTF-8-only unless explicit conversion support is added later.

Existing text files are never overwritten without an expected SHA-256. For large files, use bounded reads and exact patches instead of a full-file rewrite.
