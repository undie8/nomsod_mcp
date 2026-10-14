# TASK-007: Implement Search and Visual Image / Screenshot Tools for ChatGPT

**Status**: Completed ✅
**Created Date**: 2026-10-15
**Completed Date**: 2026-10-15
**Owner**: Antigravity

## 1. Description & Scope
Add search and image capabilities to Nomsod MCP so ChatGPT and other LLMs can efficiently navigate codebases and inspect web UI visuals directly:
1. **`search_files` Tool**:
   - Fast, dependency-free text/regex search across directories.
   - Automatically ignores `node_modules`, `.git`, `dist`, `build`, `.next`, `tmp`, `.cache`.
   - Bounded results (default 50, max 200) to conserve LLM tokens.
   - Returns structured matches with file, line number, column, and line preview.
2. **`read_image_file` Tool**:
   - Reads image files (`.png`, `.jpg`, `.jpeg`, `.webp`, `.svg`, `.gif`) on disk.
   - Returns standard MCP image content `{ type: "image", data: base64, mimeType }`.
3. **`capture_screenshot` Tool**:
   - Cross-platform native screenshot capture (Windows PowerShell System.Drawing/Graphics.CopyFromScreen, macOS `/usr/sbin/screencapture -x`).
   - Returns standard MCP image content so ChatGPT can view rendered web UI directly.

## 2. Findings & Context Discoveries
- Baseline test state: 10 test files, 34 tests passing.
- Post-implementation test state: 13 test files, 43 tests passing.
- MCP spec in `@modelcontextprotocol/server` natively supports `{ content: [{ type: "image", data: string, mimeType: string }] }`.
- Zero third-party npm packages added: `search-helper` uses Node.js streaming file system traversal with binary null-byte check, and `visual-helper` uses native PowerShell/macOS capture and header-based dimension parsing.
- Windows screenshot capture executes in ~700ms with zero memory leaks and atomic temp file cleanup.

## 3. Plan & Testable Slices
- [x] Slice 1: Subagent research & contract design (search-types, visual-types).
- [x] Slice 2: Implement search engine in `src/agent/search-helper.ts` and test suite `tests/search.test.ts`.
- [x] Slice 3: Implement visual & screenshot engine in `src/agent/visual-helper.ts` and test suite `tests/visual.test.ts`.
- [x] Slice 4: Route actions in `src/agent/actions.ts` / `src/agent/main.ts` and register MCP tools in `src/gateway/mcp.ts`.
- [x] Slice 5: Verification, build, deploy to LocalAppData, and live end-to-end testing.

## 4. Verification Evidence
1. **Automated Unit Tests**:
   - Full suite passes 13/13 test files and 43/43 tests:
     - `tests/search.test.ts`: 3 tests passing (find matches, pattern filter, maxResults truncation).
     - `tests/visual.test.ts`: 4 tests passing (read SVG, read 1x1 PNG, error handling, native Windows screenshot).
     - `tests/mcp-search-and-visual-tools.test.ts`: 2 tests passing.
2. **TypeScript Typecheck & Build**:
   - `npm run typecheck` passes with 0 errors.
   - `npm run build` compiles `dist/` cleanly.
3. **Deployment**:
   - Deployed updated binaries and scripts to `C:\Users\gunnc\AppData\Local\Nomsod MCP`.
   - Windows Control binaries rebuilt cleanly with transparent cat icon.

