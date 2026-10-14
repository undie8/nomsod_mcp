# TASK-005: Windows Tray Icon Live Jobs Monitor & Local Control Endpoint

**Status**: Completed ✅
**Completed Date**: 2026-10-15
**Owner**: Antigravity

## 1. Description & Scope
Provide direct Windows System Tray observability for running background jobs without needing a web browser:
1. In `src/agent/main.ts`, extend the local health server on port 3232 (`http://127.0.0.1:3232`) with:
   - `GET /jobs`: Returns `{ ok: true, jobs: jobManager.listJobs() }`.
   - `POST /jobs/cancel`: Cancels a specified `jobId`.
   - `GET /health`: Includes `activeJobs: number`.
2. In `scripts/windows/NomsodMcpControl.cs`:
   - Add dynamic active job count status display (e.g. `Active Jobs: 1 running` or `Active Jobs: None`) in the tray context menu.
   - Add context menu item: `Active Jobs & Live Monitor...` opening `JobsMonitorForm`.
   - Implement `JobsMonitorForm`:
     - Top section: List of jobs (`ListView`) with columns Status, Duration, Command, PID, Job ID.
     - Middle section: Live Console Output box (`TextBox` multiline, read-only, dark `#1e1e1e`, font Consolas) auto-scrolling with latest `stdoutTail` and `stderrTail`.
     - Bottom section: 1s auto-refresh timer checkbox, `Cancel Job` button, `Copy Output` button, `Refresh` button, and `Close` button.
3. Compile `build\windows\Nomsod MCP Control.exe` via `scripts/windows/build-control.ps1`.
4. Deploy updated binary to `%LOCALAPPDATA%\Nomsod MCP\build\windows` and restart the tray control task.

## 2. Findings & Context Discoveries
- Agent Guardian's port 3232 is local-only and provides fast querying with zero network overhead.
- Native WinForms `JobsMonitorForm` operates cleanly without requiring a browser or extra web process.
- Successfully deployed to `%LOCALAPPDATA%\Nomsod MCP\build\windows\Nomsod MCP Control.exe` and verified process running.

## 3. Plan & Testable Slices
- [x] Slice 1: Add `/jobs` and `/jobs/cancel` endpoints to Agent Guardian healthServer in `src/agent/main.ts`.
- [x] Slice 2: Implement `JobsMonitorForm` and menu item in `scripts/windows/NomsodMcpControl.cs`.
- [x] Slice 3: Compile via `scripts/windows/build-control.ps1` and verify build success.
- [x] Slice 4: Deploy and verify live operation.

## 4. Verification Evidence
- `npm run typecheck`: clean exit code 0.
- `npm test`: all 10 test files and 32 unit tests passing.
- `build-control.ps1`: built `Nomsod MCP Control.exe` cleanly.
- Deployed to `%LOCALAPPDATA%\Nomsod MCP` and verified `Nomsod MCP Control.exe` running (PID 43892).
