# TASK-004: Async Command Execution, SSE Keep-Alive, and Local Jobs Observability

**Status**: Completed ✅
**Completed Date**: 2026-10-15
**Owner**: Antigravity

## 1. Description & Scope
Long-running commands (such as test suites, builds, or deployments) executed by ChatGPT or Gemini over MCP previously blocked synchronously in `execute_command` for up to 120-300 seconds. Because no SSE tokens/data flowed during this silence, the browser client-side delivery timer tripped with `Message delivery timed out. Please try again` or `Connection interrupted`.

This task implements a 3-tier defense:
1. **Async Command Execution**: Dedicated MCP tools `execute_command_async`, `get_command_status`, and `cancel_command`. Long-running tasks start in background, returning a `jobId` in < 200ms, allowing the LLM to poll status and stream progress tokens into the chat without blocking.
2. **Robust Job & Process Tree Management**: Implement `JobManager` in `src/agent/job-manager.ts` managed by the persistent `Agent Guardian` (`src/agent/main.ts`), using fixed Ring Buffers for stdout/stderr to prevent memory leaks and Windows `taskkill /pid <PID> /t /f` / POSIX process-group kill to prevent zombie processes.
3. **SSE Keep-Alive Fallback**: In `src/supervisor/runtime-manager.ts`, inject periodic SSE comment lines (`: ping\n\n`) every 15s when proxying `text/event-stream` to keep the connection between LLM cloud and Nomsod active.
4. **Local Observability**: Add a `GET /jobs` and `GET /devices/:id/jobs` endpoint on Supervisor (`src/supervisor/main.ts`) for real-time visibility into active/recent jobs.

## 2. Findings & Context Discoveries
- Anchored `JobManager` in `Agent Guardian` (`src/agent/main.ts`) rather than replaceable action workers so in-flight background jobs persist during routine hot-reloads.
- Process tree cleanup on Windows correctly uses `taskkill /pid <PID> /t /f` to prevent orphaned child processes (e.g. node, npm, python).
- RingBuffer caps memory to max 200 lines and 64KB per stream, with a 5-minute unref interval pruning jobs older than 1 hour or exceeding 200 completed records.
- SSE keep-alive comments (`: ping\n\n`) are strictly isolated to `Content-Type: text/event-stream` and never corrupt JSON-RPC responses.
- Local endpoint `GET /jobs` allows direct browser inspection from localhost without OAuth credentials, while remote requests enforce OAuth challenge.

## 3. Plan & Testable Slices
- [x] Slice 1: Implement `JobManager` in `src/agent/job-manager.ts` with ring-buffer stdout/stderr, process tree kill, and TTL cleanup.
- [x] Slice 2: Integrate `JobManager` with `Agent Guardian` (`src/agent/main.ts`) handling `job.start`, `job.status`, `job.cancel`, and `job.list`.
- [x] Slice 3: Register MCP tools (`execute_command_async`, `get_command_status`, `cancel_command`) in `src/gateway/mcp.ts`.
- [x] Slice 4: Implement SSE Keep-Alive in `src/supervisor/runtime-manager.ts` and `GET /jobs` endpoint in `src/supervisor/main.ts`.
- [x] Slice 5: Add unit tests in `tests/job-manager.test.ts` and `tests/mcp-async-tools.test.ts`, verifying all 32 tests pass cleanly.

## 4. Verification Evidence
- `npm run typecheck`: clean exit with code 0 (no errors).
- `npm test`: all 10 test files and 32 unit tests passing (`vitest run`).
- Verified starting, polling, and cancelling background jobs on Windows with PowerShell.
- Verified MCP async job tool handler initialization and payload structure.
