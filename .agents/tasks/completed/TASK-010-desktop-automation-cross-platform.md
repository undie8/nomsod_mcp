# TASK-010: Cross-Platform Desktop Automation & Connection Stability Hardening

## 1. Description & Scope
Implement native, layout-independent Desktop Automation (mouse movement, clicks, unicode typing, hotkeys, window listing, and window focus) directly in Nomsod MCP for both Windows and macOS (MacBook), without third-party CLI or npm dependencies. Concurrently, harden connection stability against sleep/wake cycles, network switches, and peer reconnection storms so device connections do not drop or hang.

## 2. Findings & Context Discoveries
- **Root Cause of Keyboard Glitch**: ChatGPT was previously running custom PowerShell scripts via `execute_command` using `WScript.Shell.SendKeys`. `SendKeys` synthesizes keystrokes through the active Windows keyboard layout (Thai), corrupting English URLs into Thai characters. Win32 `SendInput` with `KEYEVENTF_UNICODE` (0x0004) sends UTF-16 code units directly to the window, completely immune to keyboard layout.
- **Root Cause of Connection Drops**:
  1. Offline Tailscale peers were added to `gatewayUrls` indefinitely and reconnected every 30s with a 15s handshake timeout, creating reconnect storms and filling logs.
  2. `hasConnectedPrimaryGateway` treated `ws://127.0.0.1:34100/agent` as primary, causing devices running `ROLE=both` (like a MacBook) to park the public gateway `wss://mcp.nomsod.net/agent` even when no remote peer connected it to the cluster host.
  3. Laptops sleeping and waking experienced broken TCP sockets without prompt notification until a 45s stale timeout, plus high backoff retry delays.
- **Cross-Platform Native Approach**:
  - Windows: Win32 APIs via C# CLI `NomsodDesktopWin.exe` with `OpenWindowStation("winsta0")` and `OpenDesktop("Default")` desktop attachment, `SendInput` (Unicode), `mouse_event`, `EnumDesktopWindows`, `AttachThreadInput` + `SetForegroundWindow`.
  - macOS: `osascript` (AppleScript System Events for layout-independent `keystroke`, key codes, and app activation; JXA CoreGraphics for coordinate mouse moves and clicks).

## 3. Implementation Slices
- [x] Slice 1: Connection Stability Hardening (Sleep/wake timer drift, TCP keep-alive, prune offline peers, loopback routing fix)
- [x] Slice 2: Shared Contracts & Capabilities (`src/shared/desktop-types.ts`, `src/shared/identity.ts`)
- [x] Slice 3: Windows Desktop Automation Engine (`src/agent/desktop-helper.ts`, `scripts/windows/NomsodDesktopWin.cs`)
- [x] Slice 4: macOS Desktop Automation Engine (`src/agent/desktop-helper.ts` with JXA CoreGraphics & AppleScript)
- [x] Slice 5: Action Routing & MCP Tools Registration (`src/agent/actions.ts`, `src/gateway/mcp.ts`)
- [x] Slice 6: Automated Testing & Verification (`tests/desktop.test.ts`, `tests/mcp-desktop-tools.test.ts`, `tests/gateway-routing.test.ts`)
- [x] Slice 7: Build, Local Deployment & End-to-End Verification

## 4. Verification Evidence
- `npm run typecheck`: Passed with 0 errors across all shared, gateway, and agent files.
- `npm test`: 17/17 test files passed, 58/58 tests passed (including 7 desktop tests and 2 MCP desktop tool tests).
- `build-control.ps1`: Successfully compiled `NomsodDesktopWin.exe` alongside Control and Background executables.
- `publish.ps1`: Built v0.4.21 distribution packages for Windows (.zip) and macOS (.tar.gz) with SHA-256 manifests.
- Blue/Green Supervisor cut-over: Live switched from runtime `20261014185442-ecc5e28a` (PID 25296) to runtime `20261015052336-479152fc` (PID 42888).
- End-to-End Live Probing:
  - `desktop.get_cursor_position`: Successfully returned active coordinates `{ ok: true, x: -1669, y: 694 }`.
  - `desktop.list_windows`: Successfully enumerated visible windows with bounds (Antigravity PID 60616, Chrome PID 40944, etc.).
