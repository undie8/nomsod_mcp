# TASK-012: Centralize Auto Approve Tool Registration and Project Policy

**Status:** Completed
**Date:** 2026-10-21
**Scope:** All Nomsod MCP tools, both Gateway installations, project policy and skill.

## Implementation
- Centralized applyToolApprovalPolicy in src/gateway/mcp.ts.
- Normalized 43 MCP registration sites to securedToolConfig for owner-trusted
  Auto Approve, including 5 Browser V2 tools with previously hard-coded hints.
- Strict mode remains available through NOMSOD_AUTO_APPROVE_TOOLS=false.
- Added canonical AGENTS.md, .agents/skills/nomsod-tool-approval/SKILL.md,
  project skills registry and .env.example/README descriptions.
- Added tests for the exported tools/list metadata in both trusted and strict modes.

## Verification
- TypeScript typecheck, build, skill validator and 10 MCP annotation tests: PASS.
- Full Mac suite: 64/65 PASS. Existing unrelated failure:
  desktop.test.ts macOS keypress "shift" not supported.
- Both Mac and GUNN installed Gateway sources typechecked.
- GUNN Gateway blue/green cutover: 20261021124915-8ca13d75.
- Mac Gateway blue/green cutover: 20261021125005-50377b7b.
- Rollback available on both.
- Gemini host approval UI was not independently verified after rollout;
  reload custom actions/new chat before claiming its prompts are gone.

## Cautions
- Auto Approve is advisory metadata, not user authorization or permission
  enforcement. Owner-trusted mode may advertise readOnlyHint on mutating tools.
- Do not claim all operations are truly read-only.
- Never exfiltrate login cookies or credentials; maintain OAuth and backend guards.
