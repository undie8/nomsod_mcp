# TASK-20261023-dependency-hardening: Clear dependency advisories and verify Mac/UNDIE

- Status: Completed (2026-10-23); implementation and candidate verification complete, not publicly released
- Area: runtime
- Tags: dependencies, security, integration
- Summary: Remove all eight npm audit findings, bound MCP input, and verify the patched gateway with Mac and UNDIE.
- Owner: Codex chat 01a164a0-00c8-7b90-8db5-1a05d800f3c7, single agent
- Scope: package metadata/lock, gateway input limits, focused regression tests and isolated cross-platform verification.
- Excluded: unrelated jobs/business data, public release or version bump without a release selection.
- Authorization: user explicitly requested both remediation stages and Mac/UNDIE compatibility checks after the audit report.

## 1. Goal and acceptance
- npm audit reports zero vulnerabilities across all dependencies, not only production dependencies.
- Typecheck/build and affected regression tests pass; run the full suites and disclose platform-specific baseline failures. Normal MCP requests work and excessive inputs reject without dispatch or process failure.
- Real system/file/shell operations through the patched gateway succeed for Mac and UNDIE; record actual versions and runtime status.
- Preserve existing Auto Approve/Strict metadata, OAuth checks and rollback boundaries.

## 2. Findings & Context Discoveries
- Clean main at 1aeaf50; only this chat is active in this repository, no managed worktrees or in-progress task records.
- Eight affected packages: server/client, Hono, Vitest/mocker/Tinypool/Vite/source-map-js. Production-only audit has two findings (server/Hono).
- Existing server factory isolates requests; custom OAuth validates resource before SDK access. Input element limit is absent; SDK upgrade alone does not enable it.
- Node 24.13.0 on local Windows and UNDIE; Mac uses a bundled executable outside PATH and must be checked explicitly.
- Vitest 4.1.12 is the maintained V4 release, patches mocker and no longer depends on Tinypool. It preserves the declared Node 20 compatibility unlike Vitest 5.
- MCP client package is declared but has no imports in source/tests/scripts; remove the unused dependency.
- Existing release 0.4.24 has known blue/green preflight timeout and mirroring downgrade issues; do not alter those unrelated workflows or claim a deployment based on old runtime health.
- Mac full-suite discovery found three baseline desktop test failures: no enumerated windows, unsupported standalone Shift key, and macOS denies osascript keystrokes to the candidate Node process (1002). Installed and candidate desktop-helper.ts hashes both equal 65d72d533ed54e3a9a3c3a8e4f6a2f93fd4d02553a8c4875bcb3ce67c3f33ff3. Installed compiled helper reproduces unsupported Shift and zero windows. No desktop code or macOS permission changes included.
- SDK 413 handling closes the connection before reading an oversized declared body. macOS can report ECONNRESET for a still-running upload. A separate header-only real HTTP probe proves 413 with zero dispatch; tests accept only this specific observed macOS reset and require the next normal request to succeed. No production adapter workaround is needed.

## 3. Slices
- [x] Slice 1: Add failing MCP boundary regression and refresh compatible dependencies
- [x] Slice 2: Enable bounded MCP input and pass local automated verification
- [x] Slice 3: Exercise the patched gateway against real Mac/UNDIE devices, archive evidence

## 4. Verification
- Baseline audit: 8 total, 2 moderate / 4 high / 2 critical.
- Baseline connector: Mac, UNDIE and GUNN online at 0.4.24.
- Red proof: HTTP regression passed concurrent normal calls but failed both excessive element and 2 MiB UTF-8 body rejection on old code.
- Refreshed dependencies: server 2.3.1, node adapter 2.1.1, Hono 4.13.13, Vitest/mocker 4.1.12, Vite 8.3.5, source-map-js 1.2.2. Unused MCP client and Tinypool removed. npm audit: zero findings.
- Mac bundled Node is 24.13.0, matching UNDIE/local Windows. Mac has no global node on the service shell PATH; use its bundled node explicitly.
- Input bounds enabled: 10,000 tool argument elements/keys; 2 MiB UTF-8 HTTP body at both adapter and handler. Oversized requests now reject instead of dispatching.
- Local typecheck/build passed; initial full suite passed 75 tests / 21 files on Vitest 4.1.12. Added one further near-limit UTF-8 write acceptance check before native cross-platform verification.
- Patched compiled Gateway (SDK 2.3.1, 43 tools) bridged through real control service to both Mac/UNDIE: matching concurrent request IDs remained isolated; system info, directory/file read with hash, shell, runtime status passed. Invalid schema/excessive elements/oversized body rejected and subsequent calls succeeded. Receipt: ../evidence/TASK-20261023-dependency-hardening/local-live.json.
- Verification uses separate candidate processes and directories; installed 0.4.24 services remain available and no public manifest/version is changed. Live health alone is not used as evidence for the patched code.
- No independent subagent review requested; parent owns implementation and automated verification.
- Final local suite: 77 passed / 21 files; typecheck/build passed. npm audit (all dependencies) and npm audit --omit=dev: zero findings.
- Fresh isolated npm ci/typecheck/build on Mac and UNDIE passed with Node 24.13.0 and identical lockfile. UNDIE final full suite: 77 passed, zero skipped. Mac final scoped rerun: 74 passed, three known baseline desktop cases explicitly excluded by test-name pattern (not silently marked passing). First unfiltered Mac run retained as native job job_cc134394-f548-43f1-b125-d36fbb30e7f1.
- Final native jobs: Mac job_23e80c84-e204-4563-9404-19925c24e601 and UNDIE job_a0e8643e-49c5-4d0d-9e05-b22e856b7c17 completed exit 0. Each native SDK 2.3.1 gateway performed positive/negative real MCP actions against both devices; final oversized calls returned 413, and following valid calls passed.
- Compact native summaries and live receipts are stored under ../evidence/TASK-20261023-dependency-hardening/. Total evidence is below 256 KiB, contains no credentials, and no temporary verification runtime remains running.
- README documents UTF-8 body/element limits and early-close behavior. Strict UTF-8 validation and git diff --check passed for the code/test changes.
- Final native connector inventory: Mac, UNDIE, GUNN online on installed 0.4.24; Guardian and Worker processes remained healthy throughout candidate verification.

## 5. Completion
- All eight dependency warnings removed in the implementation and native candidates. Normal Mac/UNDIE file/system/shell flows verified through patched gateways on both operating systems. Existing Mac desktop test limitations remain explicitly out of scope.
- Changes remain uncommitted on main for review. No patch version bump, push, production service replacement or public artifact promotion performed in this task. Version 0.4.24 immutable artifacts remain intact; publishing requires a later terminal menu selection.
- Skills used: tdd-slice, diagnose-loop, nomsod-tool-approval, remote-computer, repo-task-tracker and prevent-encoding-mojibake (with skill-router execution contract). No skill changes needed.
