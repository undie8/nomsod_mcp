# TASK-009: Suppress Console Window Popups for Silent Background Execution on Windows

**Status**: Completed ✅
**Created Date**: 2026-10-15
**Completed Date**: 2026-10-15
**Owner**: Antigravity

## 1. Description & Scope
Eliminate transient CMD / PowerShell console window popups flashing during Nomsod MCP operations on Windows:
1. **JobManager (`src/agent/job-manager.ts`)**:
   - Normalize `shellParam`: If undefined, "powershell", or "powershell.exe", use PowerShell with `-NoLogo`, `-NoProfile`, `-NonInteractive`, `-WindowStyle`, `Hidden`, `-EncodedCommand <base64>`.
   - If "cmd" or "cmd.exe", invoke `cmd.exe /d /s /c` with `windowsHide: true`.
   - Pass `{ windowsHide: true }` when calling `taskkill` in `cancel()`.
2. **Synchronous Actions (`src/agent/actions.ts`)**:
   - Add `"-WindowStyle", "Hidden"` to PowerShell args.
3. **Visual Helper (`src/agent/visual-helper.ts`)**:
   - Add `"-WindowStyle", "Hidden"` to PowerShell screenshot capture.
4. **Browser Launcher (`src/agent/browser-launcher.ts`)**:
   - Add `windowsHide: true` to `spawn` options for browser process.
   - Replace `exec` with `execFileAsync("taskkill", ... , { windowsHide: true })` in `terminateProcess`.
   - Use `execFileAsync` for `where`/`which` browser binary lookup with `windowsHide: true`.
5. **Background Scripts**:
   - Add `-WindowStyle Hidden` in `scripts/windows/update.ps1` and `scripts/windows/NomsodMcpBackground.cs`.

## 2. Findings & Context Discoveries
- In `job-manager.ts`, when ChatGPT provided `shell: "powershell"`, it took the plain-text command branch `spawn("powershell.exe", [command])` without `-WindowStyle Hidden` or `-EncodedCommand`, causing interactive console allocation.
- In `browser-launcher.ts`, `terminateProcess` used `exec("taskkill ...")` without `windowsHide: true`, causing CMD window flashes.
- By enforcing `-WindowStyle Hidden` and `windowsHide: true` across all PowerShell and child process invocations, all background executions run completely silently without stealing user focus or flashing on the screen.

## 3. Plan & Testable Slices
- [x] Slice 1: Fix `src/agent/job-manager.ts` shell normalization & taskkill windowsHide.
- [x] Slice 2: Fix `src/agent/actions.ts` & `src/agent/visual-helper.ts` WindowStyle Hidden.
- [x] Slice 3: Fix `src/agent/browser-launcher.ts` spawn windowsHide & taskkill execFile.
- [x] Slice 4: Fix `scripts/windows/update.ps1` & `scripts/windows/NomsodMcpBackground.cs`.
- [x] Slice 5: Verification with Vitest, build, deploy, restart runtime, and test evidence.

## 4. Verification Evidence
1. **Automated Unit Tests**:
   - 15/15 test files passing, 47/47 tests passing (`npm test`).
   - `tests/job-manager.test.ts`: 5/5 tests passing with full command lifecycle, listing, cancellation, and output capture.
   - `tests/browser.test.ts`: 2/2 tests passing (discovery, full lifecycle navigation, click, type, screenshot in ~1.4s).
2. **TypeScript Typecheck & Build**:
   - `npm run typecheck` passes with 0 errors.
   - `npm run build` compiles cleanly.
   - C# control and background binaries built cleanly via `scripts/windows/build-control.ps1`.
3. **Deployment & Live Runtime Verification**:
   - Deployed updated `dist` and `src` to `C:\Users\gunnc\AppData\Local\Nomsod MCP`.
   - Supervisor and Agent Guardian restarted with fresh runtime snapshots.
   - Verified `/health` on both Supervisor (34100) and Agent Guardian (34122) reporting `ok: true`.
