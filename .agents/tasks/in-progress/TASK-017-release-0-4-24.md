# TASK-017: Publish and deploy Nomsod MCP 0.4.24

- Status: In Progress
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

## 3. Slices
- [x] Slice 1: Bump metadata, validate intended release scope
- [ ] Slice 2: Commit and push main <- Current Focus
- [ ] Slice 3: Publish/deploy, verify public artifacts/NAS/devices, archive evidence

## 4. Verification
- npm run typecheck/build passed at 0.4.24; Windows Control build and real WinForms monitor smoke passed.
- TASK-016 full suite passed 72 tests before version-only metadata changes; canonical publisher will rerun full validation for this release.
- Verified resolved release staging directory remains under this checkout and is not a reparse point.

## 5. Completion
- Pending.
