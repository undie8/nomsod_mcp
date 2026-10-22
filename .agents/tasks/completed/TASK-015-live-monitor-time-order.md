# TASK-015: Live Monitor newest-first rows and start time

- Status: Completed (2026-10-23)
- Owner: Codex chat 01a164a0-00c8-7b90-8db5-1a05d800f3c7 (single agent, approved mode 1)
- Scope: Windows Control jobs monitor, focused verification, local tray update

## 1. Goal and acceptance
- Sort rows by startedAt descending; show local date/time in a Started column.
- Preserve selected job and its output across refreshes.
- Compile Windows Control and exercise real WinForms rendering and refresh.
- Update only the local tray application after verification; do not restart workers or publish.

## 2. Findings & Context Discoveries
- Working tree clean on main; no active task records or competing active chat found.
- src/agent/job-manager.ts listJobs preserves insertion order and exposes startedAt.
- scripts/windows/NomsodMcpControl.cs ParseJobs currently ignores startedAt.
- UI already restores selection by JobId; retain this behavior.
- Baseline C# test failed with `Newest job must be first`; after parsing StartedAt and sorting, it passes.
- WinForms fixture verified local date/time, newest-first rendering, automatic refresh preserving selection and output.
- Empty-list verification exposed stale output; explicitly clearing output after an empty refresh resolves the reproduced failure.
- Missing, non-positive and out-of-range timestamps display a dash.
- Installed Guardian uses configured port 34122, not default 3232; health and jobs endpoints succeeded. All 65 current live jobs expose startedAt.

## 3. Slices
- [x] Slice 1: Verify baseline, parse and sort timestamps
- [x] Slice 2: Display local Started time and verify refresh selection
- [x] Slice 3: Build, local tray update and final verification

## 4. Verification
- Windows PowerShell 5: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File tests/windows/test-jobs-monitor.ps1` passed.
- Test executes real Control source with a localhost HTTP fixture and real WinForms ListView/timers; verifies manual empty refresh too.
- `scripts/windows/build-control.ps1`: passed.
- `npm run typecheck`, `npm run build`, `npm test`: passed (18 files, 65 tests).
- Local tray only replaced and restarted via existing NomsodMCP-Control scheduled task; new PID 9612, SHA-256 matches built executable. Guardian health remains OK.
- Rollback executable retained in local temporary directory `nomsod-monitor-backup-827c935d169448f8aaa693630cddc992`.
- Self-review: narrow Control diff, no MCP registrations, backend or credential changes. Automated native UI tests passed; no independent subagent review requested.
- Limitation: UI behavior exercised through local HTTP fixtures in real WinForms; no manual visual acceptance or remote-device deployment.

## 5. Completion
- Delivered newest-first sorting, local Started date/time, retained selection/output and empty-output cleanup; updated this machine's tray. No commit, push or remote deployment.
