# TASK-016: AC-only Mac availability and reconnect recovery

- Status: Completed (2026-10-23)
- Owner: Codex chat 01a164a0-00c8-7b90-8db5-1a05d800f3c7; single agent
- Scope: Mac AC-only keep-awake configuration; Agent Guardian reconnect lifecycle; focused tests; Mac and UNDIE agent deployment
- Excluded: unrelated TASK-015 edits, credentials, battery/display sleep policies, public release/push, Gateway/Worker contracts

## 1. Goal and acceptance
- Keep Mac available on AC power while display sleep and battery sleep remain permitted.
- Preserve healthy connections on wake; reject dead connections after a bounded grace period.
- One pending reconnect per gateway; discovery cannot bypass backoff; removed peers cannot reconnect from stale timers.
- Verify real WebSocket handshake/heartbeat/drop/recovery and negative cases, plus typecheck/build/full tests.
- Preserve rollback and avoid restarting guardians while unrelated jobs run.

## 2. Findings & Context Discoveries
- Confirmed from Mac powerd and UNDIE logs: 775/775 Mac handshake timeouts overlap recorded Mac sleep intervals (772 directly asleep, 3 handshake windows overlap).
- Mac currently on battery (42%); AC and battery sleep both 1 minute, display sleep AC 30 / battery 10 minutes.
- sudo -n requires a password; use native user-level caffeinate AC-only assertion if supported by the installed manual, without changing battery/display settings.
- Existing timers: anonymous reconnect setTimeout, peer discovery connect() every 30s, no pending timer registry; removed peers can reconnect.
- Wake handler pings OPEN sockets but stale timer still uses old lastInbound and can immediately terminate them; no pong listener.
- Ownership inspected: no other active source writer/task/worktree; earlier TASK-015 uncommitted changes preserved.
- Installed macOS man page confirms caffeinate -s assertion is AC-only; -d/-u are not used, so display sleep remains allowed.
- Installed user LaunchAgent com.nomsod.mcp.keepawake-ac using /usr/bin/caffeinate -s; launchd running, original pmset custom output unchanged. Revert by bootout and removing only its plist.
- Initially on battery; later verified on physical AC Power: PreventSystemSleep=1, PreventUserIdleDisplaySleep=0, live pmset reports sleep prevented by caffeinate; display sleep remains 30 minutes AC / 10 minutes battery, battery sleep remains 1 minute.
- Added ReconnectScheduler: one timer per URL, backoff preserved until ready, timers canceled on peer removal/shutdown.
- Added ConnectionLiveness: bounded post-pause grace independent of timer callback order, pong refresh, immediate wake heartbeat.
- Real Guardian regression test fails on original HEAD with an unnecessary second connection after simulated wake; fixed source passes with exactly one connection, and command routing succeeds after an actual forced socket drop.
- Full verification passed: typecheck/build, 20 test files / 72 tests. Native Mac installed source typecheck and compiled recovery-module smoke passed.
- Deployment copies guarded by fresh SHA-256 reads; source matched inspected HEAD. Backups: Mac data/rollback/task016-20261022T175501Z, UNDIE data/rollback/task016-20261022T175500Z.
- UNDIE restarted only after activeJobs=0 and worker.inFlight=0; old Guardian 2188 -> 29076, healthy Worker and 3 gateway connections; system.info round trip passed.
- Mac had unrelated ai-config evaluation jobs; waited until they finished. Detached activation helper waits for idle, restarts only Agent launch service, and automatically restores original files on health failure. Receipt: Mac backup activation.json.
- Mac activation receipt status=activated, Guardian 25513 -> 6933 and Worker 6934 healthy; actual system.info and shell.exec round trips passed on both Mac and UNDIE. Native AC LaunchAgent remains running.
- Guardian compiled SHA-256 on both targets: 38884f9c42fb0b8f2e2997239bb9a8ccfda42e2151068ba97c4cb16c501b8287.
- README now documents backoff coalescing, bounded wake recovery, focused test commands and optional local Mac AC-only availability.

## 3. Slices
- [x] Slice 1: Configure native Mac AC-only availability with rollback
- [x] Slice 2: Add reconnect scheduling and wake recovery tests, implement bounded lifecycle
- [x] Slice 3: Full-chain verification, deploy safely to Mac and UNDIE, verify health and command routing

## 4. Verification
- Focused tests: 6 lifecycle/scheduling tests and 4 gateway-routing tests passed; typecheck passed.
- Guardian integration uses real WebSockets and real shell.exec through JobManager, with a minimal worker health fixture; tests a 120-second clock jump with delayed responses and actual socket termination/reconnection.
- Original Guardian baseline independently reproduced unnecessary wake reconnect; new Guardian integration passed before adding optional baseline selection and validated temporary-directory cleanup.
- Final full-suite run passed including updated Guardian integration. Strict UTF-8 checks and git diff --check passed before README-only documentation update.
- Review: single-agent self-review of timer ownership, shutdown, removed peers, ready-only retry reset and bounded stale recovery; no independent review requested.
- Limit: wake behavior verified via isolated real Guardian/WebSocket clock-pause simulation, not by forcing production machines to sleep; AC policy verified on actual AC power without forcing the display off.

## 5. Completion
- Completed and activated on Mac and UNDIE, with code backups and local AC LaunchAgent rollback instructions retained. No commit, push, version bump or public release. TASK-015 edits remain preserved.
