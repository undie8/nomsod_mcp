# Nomsod Browser V2 — Chrome DevTools QA

Browser V2 is built into the existing Nomsod MCP, not a second MCP server.
The agent uses Chrome DevTools Protocol (CDP) to drive Chrome and run QA checks.

## Modes
- Headless: existing browser_navigate starts an isolated temporary Chrome if no session is attached.
- Attach: browser_connect uses Chrome already running with an explicitly enabled, localhost-only CDP endpoint. It reuses that browser's logged-in session without reading/exporting cookies or passwords.
- Disconnect: browser_close disconnects from attached Chrome without killing it, while closing an internally launched headless Chrome.

The user must explicitly enable remote debugging for their chosen Chrome session. Nomsod does not copy cookie databases, password databases, session tokens or authentication headers.

## Mac KKSM Automation
The dedicated profile is started using:
  ~/KKSM-Automation/start-kksm-cdp.command

The previously configured loopback debugging port is 19224. Example workflow:
1. browser_connect with deviceId, port=19224, urlContains=master.kks.homes
2. browser_list_tabs / browser_select_tab
3. browser_snapshot, browser_hover, browser_keypress, browser_resize, browser_wait, browser_console, browser_network, browser_audit
4. browser_close to disconnect without terminating the user's Chrome

## Added tools
- browser_connect — attach to a locally authorized CDP port
- browser_list_tabs — list tabs with URL parameters redacted
- browser_select_tab — select tab by target ID
- browser_hover — hover/tooltip interaction
- browser_keypress — send keyboard events
- browser_resize — test responsive layouts
- browser_wait — wait for visible or existing selectors
- browser_console — bounded console messages and errors
- browser_network — bounded request paths, status codes, failures only
- browser_audit — basic overflow, image alt, input labels, navigation timing

Existing browser_navigate, browser_click, browser_type, browser_snapshot, browser_screenshot, and browser_close also work in attached mode.

## Security and data protection
- CDP attaches only to a loopback listener on the target machine, never remote hosts.
- Browser snapshot intentionally omits all input values (including login credentials).
- Network diagnostics remove query strings/fragments and exclude headers, bodies, cookies, and tokens.
- Chrome for automation should use a dedicated browser profile, not the owner's main personal profile.
- Production KKSM Master tests must be read-only unless specifically authorized to mutate data.
- Screenshots and console logs may contain private information; do not publish them.
- browser_audit is a lightweight heuristic, not a full Lighthouse/WCAG scan.

## Tests
- npm run typecheck
- npm run build
- npx vitest run tests/browser-v2.test.ts tests/browser.test.ts --maxWorkers=2

The test uses an isolated local Chrome instance and HTTP server, never a production user account.
