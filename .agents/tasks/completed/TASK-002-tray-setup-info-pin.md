# TASK-002: Add Secure Setup Info Dialog with PIN Protection to Nomsod Tray Control

**Status**: Completed ✅
**Completed Date**: 2026-10-14
**Owner**: Antigravity

## 1. Description & Scope
Add a dedicated, password/PIN-protected setup info viewer dialog to Nomsod MCP Control (System Tray / taskbar icon):
- Protect the info viewer with a verification PIN/Password (prompt to set PIN on first use, verify on subsequent uses, stored as SHA-256 in `data/control.pin`).
- Display all necessary connection settings:
  - Gemini Enterprise MCP parameters (MCP Server URL, Auth URL, Token URL, Client ID, Client Secret, Scope)
  - Master credentials (Owner Key, Pairing Token, Device ID, Gateway WS)
- Provide easy "Copy" buttons for each item, plus "Copy Gemini Config" and "Copy Everything" convenience actions.
- Build and deploy updated `Nomsod MCP Control.exe` to LocalAppData.

## 2. Findings & Context Discoveries
- `scripts/windows/NomsodMcpControl.cs` compiles via `scripts/windows/build-control.ps1` using `csc.exe` (System.Windows.Forms).
- Currently `RevealKeys()` in `NomsodMcpControl.cs` only displayed basic credentials in a plain MessageBox without security gating or Gemini settings.
- Gemini client secret is persisted in `data/gemini-client.secret` and is automatically read and displayed.
- System Tray task `NomsodMCP-Control` runs directly from `%LOCALAPPDATA%\Nomsod MCP\build\windows\Nomsod MCP Control.exe`.

## 3. Plan & Testable Slices
- [x] Slice 1: Implement PIN prompt dialog and rich Setup Info Form in `scripts/windows/NomsodMcpControl.cs`
- [x] Slice 2: Compile `Nomsod MCP Control.exe` via `scripts/windows/build-control.ps1`
- [x] Slice 3: Deploy to `%LOCALAPPDATA%\Nomsod MCP\build\windows` and restart `NomsodMCP-Control` task
- [x] Slice 4: Verification and user delivery

## 4. Verification Evidence
- Compiled successfully with exit code 0 via `build-control.ps1`:
  - `build\windows\Nomsod MCP Control.exe`
  - `build\windows\background\0.4.15\Nomsod MCP Background.exe`
  - `build\windows\background\0.4.15\Nomsod MCP Tunnel.exe`
- Replaced binary at `C:\Users\gunnc\AppData\Local\Nomsod MCP\build\windows\Nomsod MCP Control.exe` and refreshed `NomsodMcpControl.cs`.
- Terminated and restarted scheduled task `NomsodMCP-Control`. New process ID `20596` verified running and healthy.
- Full test suite passed (22/22 tests).
