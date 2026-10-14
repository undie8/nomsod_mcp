# TASK-001: Support Gemini Enterprise OAuth 2.0 Confidential Client in Nomsod MCP

## 1. Description & Scope
Add support for OAuth 2.0 Confidential Client (Client ID + Client Secret) in Nomsod MCP so Gemini Enterprise can connect to Nomsod MCP via its web UI.
- Allow configured or pre-registered Client ID & Client Secret (e.g. `gemini-enterprise` or environment configured).
- Support trusted Google redirect URIs (`*.google.com`, `*.googleusercontent.com`).
- Allow confidential clients to authenticate using client secret without mandatory PKCE.
- Maintain 100% backward compatibility with ChatGPT public client PKCE flow.
- Add automated test coverage and verify end-to-end.

## 2. Findings & Context Discoveries
- Nomsod MCP originally strictly enforced PKCE `S256` and registered redirect URIs.
- Gemini Enterprise web extension UI requires manual input of Authorization URL, Token URL, Client ID, Client Secret, and Scope (`mcp`).
- Gemini Enterprise does not do RFC 7591 dynamic client registration; it requires pre-shared credentials.
- Generated durable client secret under `data/gemini-client.secret` (`ngs_...`) and pre-registered client ID `gemini-enterprise`.
- Deployed updated runtime and restarted live Supervisor service on GUNN (`https://mcp.nomsod.net`).

## 3. Plan & Testable Slices
- [x] Slice 1: Add confidential client support (Client Secret + Google redirect URI handling) in `src/gateway/oauth-store.ts` and `src/gateway/oauth.ts`
- [x] Slice 2: Add comprehensive test suite in `tests/oauth-confidential.test.ts` and verify with `npm test`
- [x] Slice 3: Build distribution artifacts (`npm run build`, `npm run typecheck`) and update running supervisor service
- [x] Slice 4: Deliver credentials and instructions to user

## 4. Verification Evidence
- Vitest suite passed: 7 test files, 22 tests passing (including 5 tests in `tests/oauth-confidential.test.ts`).
- `npm run typecheck` passed cleanly with zero errors.
- External curl test to `https://mcp.nomsod.net/.well-known/oauth-authorization-server` confirms `client_secret_post` and `client_secret_basic` supported.
- External curl test to `https://mcp.nomsod.net/oauth/authorize?client_id=gemini-enterprise&redirect_uri=https://oauth-redirect.googleusercontent.com/r/test&state=123&scope=mcp` returns HTTP 200 with customized Gemini Enterprise consent form.
