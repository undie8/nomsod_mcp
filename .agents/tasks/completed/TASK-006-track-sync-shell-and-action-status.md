# TASK-006: Track Synchronous Shell Commands in JobManager and Add Lightweight Action Status

**Status**: Completed ✅
**Created Date**: 2026-10-15
**Completed Date**: 2026-10-15
**Owner**: Antigravity

## 1. Description & Scope
Previously, `JobManager` only tracked asynchronous background jobs started via `execute_command_async` (`job.start`). When ChatGPT executed standard synchronous commands (`execute_command` / `shell.exec`) or file operations (`fs.read`, `fs.patch`), they bypassed `JobManager` entirely, leaving the Windows Tray "Active Jobs & Live Monitor" window empty.

This task enhances observability without performance degradation or log bloat:
1. **Track All Shell Commands in JobManager**:
   - Route `shell.exec` through `JobManager.executeSync(params)`.
   - Synchronous commands now register in `JobManager` with PID, runtime duration, status `running` -> `completed`, and real-time streaming of stdout/stderr into the rolling ring buffer.
   - The Tray Monitor instantly displays all running commands and live terminal logs.
2. **Lightweight Last Action Status for File Operations**:
   - For high-frequency file operations (`fs.read`, `fs.patch`, `fs.write`), track only a single lightweight `lastAction` record (`{ action, detail, durationMs, timestamp }`) in `JobManager`.
   - Avoids polluting the Jobs table with hundreds of file read rows while allowing the user to see that Nomsod is actively modifying or reading files.
3. **Tray UI Display**:
   - Display `lastAction` as an activity banner in `JobsMonitorForm`.
4. **Build, Test, and Deploy**:
   - Verify unit tests, compile `Nomsod MCP Control.exe`, and deploy to `%LOCALAPPDATA%\Nomsod MCP`.

## 2. Findings & Context Discoveries
- `execute_command` maps to `shell.exec` over WebSocket RPC.
- Full output accumulation must be returned to the caller upon completion to maintain complete backward compatibility with `execFileAsync`.
- Ring buffer limits (200 lines / 64KB) continue to protect memory for UI display.
- ChatGPT heavily runs synchronous commands (`execute_command`) and file edits (`fs.read`, `fs.patch`). Tracking synchronous commands in `JobManager` provides 100% visibility into all terminal actions.
- Tracking file operations only in `lastAction` ensures <1ms latency without filling memory or the jobs list.

## 3. Plan & Testable Slices
- [x] Slice 1: Add `executeSync` and `recordAction` to `src/agent/job-manager.ts`.
- [x] Slice 2: Route `shell.exec` and record file actions in `src/agent/main.ts`.
- [x] Slice 3: Update `JobsMonitorForm` in `scripts/windows/NomsodMcpControl.cs` to show `lastAction`.
- [x] Slice 4: Add unit tests, build control binary, and deploy to LocalAppData.

## 4. Verification Evidence
1. **Automated Unit Tests**:
   - All 10 test suites and 34 tests passed cleanly:
     - `tests/job-manager.test.ts` (5 tests passing, including `should execute synchronous command and return output`).
     - `tests/mcp-async-tools.test.ts` (2 tests passing).
     - Full test duration ~4.5s.
2. **TypeScript Typecheck**:
   - `npm run typecheck` passed with 0 errors.
3. **Windows Control Binary Build**:
   - `scripts/windows/build-control.ps1` compiled `Nomsod MCP Control.exe` with 0 warnings/errors.
4. **Live Runtime Verification**:
   - Deployed updated runtime files to `C:\Users\gunnc\AppData\Local\Nomsod MCP`.
   - Queried `http://127.0.0.1:34122/jobs` during active ChatGPT session in `kksm-supabase`.
   - Verified that `jobs` captured synchronous shell executions (e.g. `job_1566612b-...`, `job_145d7b87-...`) with command text, PID, duration, exit code, and live stdout tail.
   - Verified that `lastAction` captured file operations (e.g. `fs.read` on `scripts\repo-hygiene\test-ci-workflow.mjs` in 14ms).
   - The Tray Live Monitor displays the activity strip and live terminal console without needing a web browser.

