# TASK-017: Publish and deploy Nomsod MCP 0.4.24

- Status: Completed (2026-10-23)
- Owner: Codex chat 01a164a0-00c8-7b90-8db5-1a05d800f3c7, single agent
- Authorization: user selected canonical end-of-task option 7 (patch+push+deploy).
- Scope: TASK-015/TASK-016, patch version metadata, existing release/distribution/NAS workflow and device health verification.

## 1. Goal and acceptance
- VERSION/package/package-lock 0.4.23 -> 0.4.24, intended changes committed and pushed on main.
- Build/test Windows and TypeScript artifacts; publish immutable SHA-verified Windows/macOS packages and latest pointers.
- Verify public distribution and NAS bootstrap, plus Mac/UNDIE/GUNN health and version where available.
- Preserve rollback and machine-local AC keepawake preference; avoid disrupting unrelated active jobs.

## 2. Findings & Context Discoveries
- HEAD and origin/main synchronized at 23b1636; working tree contains only this chat's TASK-015/TASK-016 changes.
- Public latest Windows and macOS manifests currently 0.4.22; local UNDIE version 0.4.23, Mac/GUNN 0.4.22.
- Repository publisher validates, builds immutable packages, promotes latest pointers last and performs best-effort NAS bootstrap synchronization.
- Root canonical menu takes precedence over legacy numeric aliases in git-main-workflow skill.
- Added a narrow absolute-path guard to NAS publisher's computed temporary cleanup directory before invoking its recursive cleanup; PowerShell parser passed.
- npm install left dependency resolutions unchanged. npm audit reports 8 pre-existing advisories (2 moderate, 4 high, 2 critical; critical findings are dev test dependencies). No broad dependency upgrade is included in this release.
- Committed intended 17-file scope and version 0.4.24 as dc42416; pushed origin/main, clean and synchronized before publishing.
- Canonical publisher passed all 72 tests/build and published both immutable packages; NAS bootstrap synchronization succeeded.
- Initial public verification rejected stale 0.4.22 manifests. Observed mirror scripts can overwrite newer local pointers with an older public manifest; UNDIE Supervisor had no peer listener because its initial startup preceded Tailscale readiness. No speculative mirror-code change was added to immutable 0.4.24 artifacts.
- Operational recovery: temporarily disabled UNDIE updater, restored verified latest pointers, deployed committed files, then restarted idle Supervisor. Peer listener 100.109.221.123:34104 appeared; public federation immediately selected 0.4.24. Restored updater enabled state afterward.
- Blue/green Gateway reload preflight timed out at 120 seconds before cutover; existing runtime remained healthy. Used controlled rolling restart after zero in-flight requests instead. Required source checks/build/full tests and native real-flow checks passed; no claim of successful blue/green cutover.
- Mac updated through canonical update.sh with an idle-waiting detached helper and prior-code backup; activation receipt status=updated, exit=0, installedVersion=0.4.24. AC keepawake LaunchAgent survived.
- UNDIE activated Guardian 0.4.24 only after unrelated jobs finished, updated Control binary/source and package metadata; Worker and 3 gateway connections healthy. GUNN's existing updater completed 0.4.24 automatically.
- Temporary public-artifact-only Tailscale transfer listener expired and exited; it was not needed after restoring the normal peer endpoint. Mac SSH fallback refused an unknown host key; no host verification was disabled.
- Follow-up: prevent mirror version downgrades, investigate old blue/green typecheck timeout, and assess pre-existing npm audit advisories separately.

## 3. Slices
- [x] Slice 1: Bump metadata, validate intended release scope
- [x] Slice 2: Commit and push main
- [x] Slice 3: Publish/deploy, verify public artifacts/NAS/devices, archive evidence

## 4. Verification
- npm run typecheck/build passed at 0.4.24; Windows Control build and real WinForms monitor smoke passed.
- TASK-016 full suite passed 72 tests before version-only metadata changes; canonical publisher will rerun full validation for this release.
- Verified resolved release staging directory remains under this checkout and is not a reparse point.
- Publisher full suite: 20 files / 72 tests passed, typecheck/build passed; separate native Windows build and WinForms smoke passed at 0.4.24.
- Downloaded public Windows archive: 240747 bytes, SHA-256 8cde809fd97c8c51e79cb1040a2cb665b6f7a08650ec6c296d6f2495fb4c2c5c, matches manifest.
- Downloaded public macOS archive: 199380 bytes, SHA-256 99420ea764ffe1ef7cfe16d10e2f25fa31be07ec10c1f3009f7883038cf80271, matches manifest.
- Final public health: version 0.4.24, runtime alive, 3 connected devices. Both public latest manifests remained 0.4.24 after all device updates.
- Final native MCP list_computers: Mac, UNDIE, GUNN all online at 0.4.24. system.info passed on Mac/UNDIE; GUNN device_runtime_status reports live idle Worker.
- NAS STATUS.json: version/windowsVersion/macosVersion all 0.4.24, permanent authority KKSM2/KKS, public bootstrap enabled.
- Read NAS archive SHA-256 values directly over existing trusted SSH: both match the public manifests above.
- Self-review only; no independent subagent review requested. Existing dependency advisories remain; no dependency-resolution changes included.

## 5. Completion
- Released and deployed 0.4.24. Release commit dc42416 pushed to main; final evidence archived in a follow-up documentation commit. Existing rollback packages/code retained; no unrelated business-data mutations.
