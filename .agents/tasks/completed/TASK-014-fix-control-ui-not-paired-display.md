# TASK-014: Fix Control UI "(not paired)" Display Bug

## 1. Goal & Scope
- Fix cosmetic display bug in Nomsod MCP Control UI (Windows and macOS) where `ShowInfo()` displays `Device name: (not paired)` even when paired.
- Update `scripts/windows/NomsodMcpControl.cs` to resolve `displayName` from environment or computer name fallback.
- Update `scripts/macos/NomsodMcpMenuBar.swift` with identical fallback behavior.
- Update `src/shared/identity.ts` so `saveIdentity` / `loadIdentity` also stores and loads `displayName` in `device.json`.
- Rebuild Control UI executable and sync updated binary and configuration to `%LOCALAPPDATA%\Nomsod MCP`.
- Verify tests and check Info dialog display.

## 2. Findings & Context Discoveries
- `device.json` stores `deviceId` and `deviceToken`, but `displayName` was not written to `device.json`.
- `NomsodMcpControl.cs` line 192 used `ValueOr(JsonString(identityJson, "displayName"), "(not paired)")` without checking `NOMSOD_DEVICE_NAME` or `Environment.MachineName`.
- The device was verified fully paired and connected on port 34100 / 34104 with `gatewayConnected=True`.

## 3. Slices & Checklist
- [x] Slice 1: Update `src/shared/identity.ts` and test identity persistence
- [x] Slice 2: Fix `scripts/windows/NomsodMcpControl.cs` and `scripts/macos/NomsodMcpMenuBar.swift`
- [x] Slice 3: Rebuild `Nomsod MCP Control.exe`, test, and update `%LOCALAPPDATA%\Nomsod MCP`
- [x] Slice 4: Run tests and archive task <- Current Focus 🎯

## 4. Verification Evidence
- `npm run typecheck` passed (exit code 0).
- `vitest run` passed: 18 test files, 65 tests passed.
- `scripts/windows/build-control.ps1` compiled successfully:
  - `build/windows/Nomsod MCP Control.exe`
- Replaced executable in `C:\Users\gunnc\AppData\Local\Nomsod MCP\build\windows\Nomsod MCP Control.exe` and restarted task `NomsodMCP-Control` (PID: 10568).
- Updated `displayName: "UNDIE"` in `C:\Users\gunnc\AppData\Local\Nomsod MCP\data\device.json`.
- Verified formatting logic outputs:
  - `Computer: UNDIE`
  - `Device name: UNDIE`
  - `Device ID: device_6b683905-7da6-4c5b-b87e-1c950f999604`
