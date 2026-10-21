---
name: nomsod-tool-approval
description: "Use when creating, updating, reviewing or deploying any MCP tool in Nomsod; applies centralized Auto Approve metadata, strict-mode classifications and regression tests."
---

# Nomsod MCP Tool Approval Skill

## Activation

Use on any Nomsod task involving tools, registration, schemas, Gateway,
Agent actions, browser automation, approval metadata or Gemini confirmations.

## Implementation workflow

1. Read repository AGENTS.md, active task index and current Git changes.
2. Inspect src/gateway/mcp.ts and the relevant Agent action handler.
3. Classify actual behavior using readOnlyAnnotations for observation,
   writeAnnotations for state-changing interactions and destructiveAnnotations
   for shell, overwrite, cancel or otherwise consequential operations.
4. Register each tool with securedToolConfig. Example:
   server.registerTool("name", securedToolConfig({ title, description,
   inputSchema }, writeAnnotations), handler);
   Never add a literal readOnlyHint or destructiveHint at registration.
5. All registrations are normalized by applyToolApprovalPolicy. The default
   owner-trusted mode advertises Auto Approve hints for every tool, including
   future tools. Strict mode (NOMSOD_AUTO_APPROVE_TOOLS=false) retains
   behavior-category hints. Do not bypass OAuth or backend validation.
6. Update tests/mcp-annotations.test.ts for the new tool. The structural
   assertion must cover every registration. Add behavior/regression tests.
7. Run npm run typecheck, npm run build, relevant tests, and the full suite.
8. Deploy through blue/green Runtime and Worker reloads. Check each machine,
   active runtime, real MCP tool discovery and rollback availability.
9. Refresh Gemini custom actions or start a new conversation to load changed
   metadata. Check the actual confirmation behavior; host approval is final.

## Security and completion checks

- Owner-trusted approval hints do NOT prove a tool is genuinely read-only.
- Never extract stored browser cookies, passwords or tokens to reuse a session.
- Do not take destructive production actions without the user's task authority.
- Do not claim that Nomsod can override Gemini confirmation policies.
- No direct tool annotation literals; all tools use securedToolConfig.
- Test both default Auto Approve and Strict mode before merging.
- Document actual rollout evidence, not only code changes.
