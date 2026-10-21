# Nomsod MCP — Project Working Policy

Canonical repository instructions for Nomsod MCP tool development. Other documents may
explain procedures but must not override the tool-approval contract in this file.

## Auto Approve contract

- Nomsod runs in a private owner-controlled, single-cluster environment. Default
  owner preference: Auto Approve ON (NOMSOD_AUTO_APPROVE_TOOLS=true or unset).
- **Every** MCP tool, existing or future, MUST register through the local
  securedToolConfig helper in src/gateway/mcp.ts. No inline annotation literals.
  This centralizes the owner preference, OAuth scopes and metadata.
- Each registration must state its **actual effect category** for Strict mode:
  readOnlyAnnotations, writeAnnotations, or destructiveAnnotations. Do not erase
  the distinction when defining the tool, even if owner-trusted mode normalizes
  advertised approval hints.
- The centralized applyToolApprovalPolicy normalizes *all* registration hints in
  owner-trusted mode. NOMSOD_AUTO_APPROVE_TOOLS=false preserves strict categories.
- MCP annotations are advisory. They do not authorize sensitive tasks, bypass
  authentication, or compel Gemini/ChatGPT to skip confirmations.
- **Important trade-off**: In owner-trusted mode, readOnlyHint=true can be shown
  for a tool that actually modifies files or executes commands. Do not assume
  that approval hints prove an operation safe. For shared or untrusted deployments,
  use Strict mode and client-side authorization.
- Descriptions, schemas, backend permissions, hash guards and rollback safeguards
  must continue to reflect actual operations and remain enforced.

## New tool development

1. Use .agents/skills/nomsod-tool-approval/SKILL.md for every new or changed tool.
2. Register via server.registerTool(name, securedToolConfig(schema, category), handler).
3. Never hardcode approval annotations per tool. Retain both Mac and Windows
   support and the existing Guardian/Worker and Supervisor/Runtime boundaries.
4. Add contract tests and relevant tool tests. The regression test
   tests/mcp-annotations.test.ts checks that every tool uses the shared helper.
5. Verify npm run typecheck, npm run build, tests and deployment health.
6. Use blue/green reloads, verify both connected devices, and retain rollback.
7. Do not copy credentials, session tokens or browser cookie databases to
   obtain login access; attach to owner-approved localhost Chrome CDP.

## Deployment and host confirmations

- The owner requests fast approvals but still controls authorization for
  destructive production actions. Treat production KKSM data as read-only for QA
  unless a task specifically authorizes a mutation.
- Gemini owns its confirmation UI and can cache MCP tool definitions. After a
  metadata change, reload Gemini custom actions or start a new session.
- The server cannot force host authorization. Investigate remaining prompts in
  host settings; never claim that metadata alone guarantees no dialog.

Source files: src/gateway/mcp.ts; tests/mcp-annotations.test.ts;
.agents/skills/nomsod-tool-approval/SKILL.md.
Historical context: .agents/tasks/completed/TASK-003-mcp-tool-auto-approve-annotations.md.
