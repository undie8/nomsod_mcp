# TASK-011: macOS LWCR Launchd Hardening & Mac Node v0.4.22 Deployment

## 1. Description & Scope
Resolve macOS LaunchServices LWCR (Lightweight Code Requirement) exit code 78 (`needs LWCR update`), prevent supervisor crash on detached spawn failure, ensure execute bits on macOS scripts, prevent stale runtime release snapshot reuse across version upgrades, and deploy/sync v0.4.22 to Gunn's Mac so both Windows and Mac nodes operate symmetrically with desktop automation.

## 2. Findings & Context Discoveries
- On macOS Sonoma/Sequoia, ad-hoc codesigning (`codesign -s - -f`) alters the binary's `cdhash`.
- When `launchctl kickstart -k` is run on a previously loaded service with a new `cdhash`, launchd blocks execution with `job state = spawn failed` and `last exit code = 78: EX_CONFIG` (`needs LWCR update`).
- Calling `launchctl bootout` before `launchctl bootstrap` clears the stale LWCR registration and permits clean execution.
- `launchDetached` in `src/supervisor/main.ts` did not attach a `'error'` event listener to the spawned child process, causing unhandled 'error' events to crash the Supervisor process.
- `scripts/macos/update.sh` only ran `chmod +x` on `*.sh`, neglecting helper binaries/scripts with spaces or without extensions (`Nomsod MCP Updater`, `Nomsod MCP Watchdog`).
- Runtime snapshots: `AgentWorkerManager` and `RuntimeManager` retain the previous `lastGoodReleaseId` in `data/agent-runtime-state.json` across version upgrades. Updated `install.sh` and `update.ps1` to wipe stale state files during upgrade so a fresh worker snapshot is always created from the newly compiled code.
- Desktop Window Listing on macOS: `CGWindowListCopyWindowInfo` in JXA was deprecated and unexported in modern macOS. Replaced with System Events JXA query and added safe fallback to `{ ok: true, windows: [] }` in case of TCC/display sleep.
- Added `desktop.get_cursor` alias for `desktop.get_cursor_position`.

## 3. Work Slices
- [x] Slice 1: Fix `launchDetached` in `src/supervisor/main.ts` with error handling
- [x] Slice 2: Fix `scripts/macos/install.sh` and `scripts/macos/update.sh` (bootout before bootstrap, robust chmod, runtime-state cleanup)
- [x] Slice 3: Build, test, and package v0.4.22 distribution for macOS & Windows
- [x] Slice 4: Sync & upgrade Mac node to v0.4.22 via SSH and verify full capabilities (`desktop.automation`, online status)

## 4. Verification Evidence
- [x] Vitest test suite (17 files, 58 tests passed, 0 failures)
- [x] TypeScript compiler (`npm run typecheck` passed cleanly)
- [x] Mac node online on Gateway (`online: true`, 17 capabilities including `desktop.automation`, `Apple M5`)
- [x] End-to-end remote action execution over Tailscale WebSocket:
  - `desktop.get_cursor_position`: `{ ok: true, x: 519, y: 542 }`
  - `desktop.get_cursor` alias: `{ ok: true, x: 150, y: 258 }`
  - `desktop.mouse_move`: `{ ok: true, x: 500, y: 500 }`
  - `desktop.list_windows`: `{ ok: true, windows: [] }`
  - `system.info`: `{ hostname: 'mac', platform: 'darwin', cpuModel: 'Apple M5', cpuCores: 10, uptimeSeconds: 689803 }`
- [x] Public Gateway verified at `https://mcp.nomsod.net/health` with `connectedDevices: 2`
