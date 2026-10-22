import { McpServer, createMcpHandler, requireScopes } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getNomsodVersion } from "../shared/version.js";
import type { ComputerHub } from "./hub-client.js";

export const MCP_MAX_REQUEST_BODY_BYTES = 2 * 1024 * 1024;

const oauthSecuritySchemes = [
  { type: "oauth2", scopes: ["mcp"] }
];

const oauthMeta = {
  securitySchemes: oauthSecuritySchemes
};

export interface NomsodMcpHandlerOptions {
  autoApproveTools?: boolean;
}

export function isToolAutoApproveEnabled(options?: NomsodMcpHandlerOptions): boolean {
  if (options?.autoApproveTools !== undefined) {
    return options.autoApproveTools;
  }
  const envVal = (process.env.NOMSOD_AUTO_APPROVE_TOOLS || "").trim().toLowerCase();
  return envVal !== "false" && envVal !== "0" && envVal !== "off";
}

export function getToolAnnotations(autoApprove: boolean) {
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  };

  const writeAnnotations = autoApprove
    ? {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    : {
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false
      };

  const destructiveAnnotations = autoApprove
    ? {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false
      }
    : {
        readOnlyHint: false,
        destructiveHint: true,
        openWorldHint: false
      };

  return { readOnlyAnnotations, writeAnnotations, destructiveAnnotations };
}

/**
 * Normalize client-facing approval hints for the owner-trusted auto-approval mode.
 * MCP annotations are advisory and do not override a host's confirmation policy.
 * Strict mode preserves the operation's original risk classification.
 */
export function applyToolApprovalPolicy(
  annotations: Record<string, boolean>,
  autoApprove: boolean
): Record<string, boolean> {
  if (!autoApprove) return { ...annotations };
  return {
    ...annotations,
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false
  };
}

function makeSecuredToolConfig<T extends Record<string, unknown>>(
  config: T,
  annotations: Record<string, boolean>
): T & {
  scopeChallenge: ReturnType<typeof requireScopes>;
  annotations: Record<string, boolean>;
  _meta: typeof oauthMeta;
} {
  return {
    ...config,
    scopeChallenge: requireScopes("mcp"),
    annotations,
    _meta: oauthMeta
  };
}

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

export function createNomsodMcpHandler(hub: ComputerHub, options?: NomsodMcpHandlerOptions) {
  const version = getNomsodVersion(process.cwd());
  const autoApprove = isToolAutoApproveEnabled(options);
  const { readOnlyAnnotations, writeAnnotations, destructiveAnnotations } = getToolAnnotations(autoApprove);
  // Single point of truth: every tool registered through this helper
  // inherits owner-trusted auto-approval, including future tools.
  const securedToolConfig = <T extends Record<string, unknown>>(
    config: T,
    annotations: Record<string, boolean>
  ) => makeSecuredToolConfig(config, applyToolApprovalPolicy(annotations, autoApprove));

  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "nomsod-mcp", version },
      {
        capabilities: { tools: {} },
        maxToolInputElements: 10_000,
        instructions:
          "Use list_computers before machine-specific work unless the target deviceId is already known and fresh. Preserve UTF-8 and prefer hash-guarded patch_text_file for existing text files."
      }
    );

    server.registerTool(
      "list_computers",
      securedToolConfig(
        {
          title: "List connected computers",
          description:
            "List computers currently connected to Nomsod MCP. Device names are discovered at runtime and are never hardcoded."
        },
        readOnlyAnnotations
      ),
      async () => textResult({ computers: await hub.listDevices() })
    );

    server.registerTool(
      "get_system_info",
      securedToolConfig(
        {
          title: "Get computer system information",
          description: "Read system information from a connected computer.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId }) => textResult(await hub.request(deviceId, "system.info"))
    );

    server.registerTool(
      "list_directory",
      securedToolConfig(
        {
          title: "List directory",
          description: "List files and directories on a connected computer.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, path }) =>
        textResult(await hub.request(deviceId, "fs.list", { path }))
    );

    server.registerTool(
      "read_text_file",
      securedToolConfig(
        {
          title: "Read UTF-8 text file",
          description:
            "Read a complete UTF-8 text file. The result includes SHA-256 for safe compare-and-write updates.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, path }) =>
        textResult(await hub.request(deviceId, "fs.read", { path }))
    );

    server.registerTool(
      "read_text_range",
      securedToolConfig(
        {
          title: "Read UTF-8 text range",
          description:
            "Read a bounded line range from a UTF-8 file. Returns totalLines, linesReturned, complete and SHA-256 so large files are never mistaken for complete reads.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1),
            startLine: z.number().int().min(1).optional(),
            maxLines: z.number().int().min(1).max(500).optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, path, startLine, maxLines }) =>
        textResult(
          await hub.request(deviceId, "fs.read_range", {
            path,
            startLine,
            maxLines
          })
        )
    );

    server.registerTool(
      "search_files",
      securedToolConfig(
        {
          title: "Search files",
          description:
            "Fast text or regex search across files in a directory on a connected computer. Automatically skips common build and cache directories.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            query: z.string().min(1),
            path: z.string().optional(),
            pattern: z.string().optional(),
            isRegex: z.boolean().optional(),
            caseSensitive: z.boolean().optional(),
            maxResults: z.number().int().min(1).max(200).optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, query, path, pattern, isRegex, caseSensitive, maxResults }) =>
        textResult(
          await hub.request(deviceId, "fs.search", {
            query,
            path,
            pattern,
            isRegex,
            caseSensitive,
            maxResults
          })
        )
    );

    server.registerTool(
      "read_image_file",
      securedToolConfig(
        {
          title: "Read image file",
          description:
            "Read an image file (.png, .jpg, .webp, .svg, .gif) from a connected computer and return standard MCP image content.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, path }) => {
        const res = (await hub.request(deviceId, "fs.read_image", { path })) as {
          base64: string;
          mimeType: string;
          bytes: number;
          width?: number;
          height?: number;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  path,
                  mimeType: res.mimeType,
                  bytes: res.bytes,
                  width: res.width,
                  height: res.height
                },
                null,
                2
              )
            },
            {
              type: "image" as const,
              data: res.base64,
              mimeType: res.mimeType
            }
          ]
        };
      }
    );

    server.registerTool(
      "capture_screenshot",
      securedToolConfig(
        {
          title: "Capture screenshot",
          description:
            "Capture a screenshot of the connected computer's screen and return standard MCP image content for visual UI review.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            screenMode: z.enum(["primary", "virtual"]).optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, screenMode }) => {
        const res = (await hub.request(deviceId, "desktop.screenshot", { screenMode })) as {
          base64: string;
          mimeType: string;
          bytes: number;
          width?: number;
          height?: number;
          capturedAt: number;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  screenMode: screenMode || "primary",
                  bytes: res.bytes,
                  width: res.width,
                  height: res.height,
                  capturedAt: res.capturedAt
                },
                null,
                2
              )
            },
            {
              type: "image" as const,
              data: res.base64,
              mimeType: res.mimeType
            }
          ]
        };
      }
    );

    server.registerTool(
      "browser_connect",
      securedToolConfig(
        {
          title: "Attach to an already open Chrome",
          description: "Attach to an explicitly enabled local Chrome CDP port. Reuse the existing logged-in browser session without reading/exporting cookies, tokens or passwords.",
          inputSchema: z.object({ deviceId: z.string().min(1), port: z.number().int().min(1024).max(65535), urlContains: z.string().optional() })
        },
        writeAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.connect", params))
    );

    server.registerTool(
      "browser_list_tabs",
      securedToolConfig(
        {
          title: "List Chrome tabs",
          description: "List tabs in the attached or Nomsod-launched Chrome browser; URL query parameters are redacted.",
          inputSchema: z.object({ deviceId: z.string().min(1) })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.tabs", params))
    );

    server.registerTool(
      "browser_select_tab",
      securedToolConfig(
        {
          title: "Select Chrome tab",
          description: "Select an existing Chrome tab by target ID returned by browser_list_tabs.",
          inputSchema: z.object({ deviceId: z.string().min(1), targetId: z.string().min(1) })
        },
        writeAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.select_tab", params))
    );

    server.registerTool(
      "browser_hover",
      securedToolConfig(
        {
          title: "Hover browser element",
          description: "Move the browser pointer over a CSS selector to test tooltips and hover behavior.",
          inputSchema: z.object({ deviceId: z.string().min(1), selector: z.string().min(1) })
        },
        writeAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.hover", params))
    );

    server.registerTool(
      "browser_keypress",
      securedToolConfig(
        {
          title: "Send browser key",
          description: "Send a key or key combination to the active browser tab for interaction testing.",
          inputSchema: z.object({ deviceId: z.string().min(1), key: z.string().min(1), modifiers: z.array(z.enum(['Alt','Control','Meta','Shift'])).optional() })
        },
        writeAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.keypress", params))
    );

    server.registerTool(
      "browser_resize",
      securedToolConfig(
        {
          title: "Resize browser viewport",
          description: "Emulate desktop, tablet or mobile viewport; does not edit page data.",
          inputSchema: z.object({ deviceId: z.string().min(1), width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(2160), mobile: z.boolean().optional(), deviceScaleFactor: z.number().min(0.5).max(4).optional() })
        },
        writeAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.resize", params))
    );

    server.registerTool(
      "browser_wait",
      securedToolConfig(
        {
          title: "Wait for browser element",
          description: "Wait for a CSS selector to appear, optionally requiring visible layout.",
          inputSchema: z.object({ deviceId: z.string().min(1), selector: z.string().min(1), timeoutMs: z.number().int().min(200).max(30000).optional(), visible: z.boolean().optional() })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.wait", params))
    );

    server.registerTool(
      "browser_console",
      securedToolConfig(
        {
          title: "Read browser console diagnostics",
          description: "Read bounded console errors and messages from the selected tab. Avoid exposing secrets in logs.",
          inputSchema: z.object({ deviceId: z.string().min(1), errorsOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.console", params))
    );

    server.registerTool(
      "browser_network",
      securedToolConfig(
        {
          title: "Inspect browser network diagnostics",
          description: "Read request URL paths, status codes and failures only. No headers, cookies, query strings or bodies are returned.",
          inputSchema: z.object({ deviceId: z.string().min(1), failuresOnly: z.boolean().optional(), limit: z.number().int().min(1).max(200).optional() })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.network", params))
    );

    server.registerTool(
      "browser_audit",
      securedToolConfig(
        {
          title: "Run read-only browser QA audit",
          description: "Check viewport overflow, missing element labels, missing alt text and navigation timing without modifying user data.",
          inputSchema: z.object({ deviceId: z.string().min(1) })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, ...params }) =>
        textResult(await hub.request(deviceId, "browser.audit", params))
    );

    server.registerTool(
      "browser_navigate",
      securedToolConfig(
        {
          title: "Navigate browser to URL",
          description:
            "Navigate the browser page to a specified URL with optional timeout. Automatically launches an isolated headless browser session if not already running.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            url: z.string().min(1),
            timeoutMs: z.number().int().min(100).optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, url, timeoutMs }) =>
        textResult(
          await hub.request(deviceId, "browser.navigate", {
            url,
            timeoutMs: timeoutMs ?? 30000
          })
        )
    );

    server.registerTool(
      "browser_click",
      securedToolConfig(
        {
          title: "Click browser element",
          description: "Click an element matching the CSS selector in the browser page.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            selector: z.string().min(1),
            timeoutMs: z.number().int().min(100).optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, selector, timeoutMs }) =>
        textResult(
          await hub.request(deviceId, "browser.click", {
            selector,
            timeoutMs
          })
        )
    );

    server.registerTool(
      "browser_type",
      securedToolConfig(
        {
          title: "Type text into browser element",
          description:
            "Type text into an input or textarea element matching the CSS selector in the browser page, with optional clearing.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            selector: z.string().min(1),
            text: z.string(),
            clearFirst: z.boolean().optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, selector, text, clearFirst }) =>
        textResult(
          await hub.request(deviceId, "browser.type", {
            selector,
            text,
            clearFirst: clearFirst ?? true
          })
        )
    );

    server.registerTool(
      "browser_snapshot",
      securedToolConfig(
        {
          title: "Get browser page and console snapshot",
          description:
            "Retrieve page title, URL, simplified DOM HTML snippet, and accumulated browser console logs/JavaScript errors.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            maxDepth: z.number().int().min(1).max(10).optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, maxDepth }) =>
        textResult(
          await hub.request(deviceId, "browser.snapshot", {
            maxDepth
          })
        )
    );

    server.registerTool(
      "browser_screenshot",
      securedToolConfig(
        {
          title: "Take browser web page screenshot",
          description:
            "Take a screenshot of the current browser web page (viewport or full-page) and return standard MCP image content.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            fullPage: z.boolean().optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, fullPage }) => {
        const res = (await hub.request(deviceId, "browser.screenshot", {
          fullPage: fullPage ?? false
        })) as {
          base64: string;
          mimeType?: string;
          bytes?: number;
          width?: number;
          height?: number;
        };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  fullPage: fullPage ?? false,
                  bytes: res.bytes,
                  width: res.width,
                  height: res.height
                },
                null,
                2
              )
            },
            {
              type: "image" as const,
              data: res.base64,
              mimeType: res.mimeType || "image/png"
            }
          ]
        };
      }
    );

    server.registerTool(
      "browser_close",
      securedToolConfig(
        {
          title: "Close browser session",
          description:
            "Close the headless browser session and release associated process and memory resources on the target device.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        writeAnnotations
      ),
      async ({ deviceId }) =>
        textResult(
          await hub.request(deviceId, "browser.close")
        )
    );

    server.registerTool(
      "desktop_click",
      securedToolConfig(
        {
          title: "Click mouse at desktop coordinates",
          description:
            "Move mouse to (x, y) coordinates and perform mouse click (left, right, or middle, single or double click) on the target computer. Works across Windows and macOS.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            x: z.number().optional(),
            y: z.number().optional(),
            button: z.enum(["left", "right", "middle"]).optional(),
            double: z.boolean().optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, x, y, button, double }) =>
        textResult(
          await hub.request(deviceId, "desktop.click", { x, y, button, double })
        )
    );

    server.registerTool(
      "desktop_mouse_move",
      securedToolConfig(
        {
          title: "Move mouse to desktop coordinates",
          description:
            "Move mouse cursor smoothly to exact (x, y) screen coordinates without clicking.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            x: z.number(),
            y: z.number()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, x, y }) =>
        textResult(
          await hub.request(deviceId, "desktop.mouse_move", { x, y })
        )
    );

    server.registerTool(
      "desktop_get_cursor_position",
      securedToolConfig(
        {
          title: "Get current desktop cursor position",
          description:
            "Retrieve current screen coordinates (x, y) of the mouse cursor on the target computer.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId }) =>
        textResult(
          await hub.request(deviceId, "desktop.get_cursor_position")
        )
    );

    server.registerTool(
      "desktop_type",
      securedToolConfig(
        {
          title: "Type text layout-independently",
          description:
            "Type text directly into the active foreground window using layout-independent Unicode input (immune to Thai or non-English keyboard layout corruption). Works on Windows and macOS.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            text: z.string(),
            delayMs: z.number().optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, text, delayMs }) =>
        textResult(
          await hub.request(deviceId, "desktop.type", { text, delayMs })
        )
    );

    server.registerTool(
      "desktop_key_press",
      securedToolConfig(
        {
          title: "Press key or hotkey combination",
          description:
            "Press a keyboard key or hotkey with modifiers (e.g. key='enter', 'tab', 'escape', 'backspace', or key='c' with modifiers=['ctrl']). Works on Windows and macOS.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            key: z.string().min(1),
            modifiers: z.array(z.enum(["ctrl", "alt", "shift", "cmd", "meta"])).optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, key, modifiers }) =>
        textResult(
          await hub.request(deviceId, "desktop.key_press", { key, modifiers })
        )
    );

    server.registerTool(
      "desktop_list_windows",
      securedToolConfig(
        {
          title: "List active application windows",
          description:
            "List visible application windows on the desktop with window title, process name, PID, HWND/ID, and window screen bounds (x, y, width, height).",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            filter: z.string().optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, filter }) =>
        textResult(
          await hub.request(deviceId, "desktop.list_windows", { filter })
        )
    );

    server.registerTool(
      "desktop_focus_window",
      securedToolConfig(
        {
          title: "Bring application window to foreground",
          description:
            "Activate and focus a window by its window ID/HWND, title substring, or process name so subsequent mouse and keyboard inputs target the correct application.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            id: z.union([z.number(), z.string()]).optional(),
            title: z.string().optional(),
            processName: z.string().optional()
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, id, title, processName }) =>
        textResult(
          await hub.request(deviceId, "desktop.focus_window", { id, title, processName })
        )
    );

    server.registerTool(
      "patch_text_file",
      securedToolConfig(
        {
          title: "Patch UTF-8 text file safely",
          description:
            "Apply exact text replacements to a UTF-8 file using an expected SHA-256. Each replacement must match the expected occurrence count, preventing stale or partial-read overwrites.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1),
            expectedSha256: z.string().length(64),
            replacements: z
              .array(
                z.object({
                  oldText: z.string().min(1),
                  newText: z.string(),
                  expectedOccurrences: z.number().int().min(1).optional()
                })
              )
              .min(1)
          })
        },
        writeAnnotations
      ),
      async ({ deviceId, path, expectedSha256, replacements }) =>
        textResult(
          await hub.request(deviceId, "fs.patch", {
            path,
            expectedSha256,
            replacements
          })
        )
    );

    server.registerTool(
      "write_text_file",
      securedToolConfig(
        {
          title: "Safely write UTF-8 text file",
          description:
            "Create a UTF-8 text file or safely overwrite an existing one. Existing files require expectedSha256 from read_text_file to prevent stale writes and encoding corruption.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            path: z.string().min(1),
            content: z.string(),
            expectedSha256: z.string().length(64).optional()
          })
        },
        destructiveAnnotations
      ),
      async ({ deviceId, path, content, expectedSha256 }) =>
        textResult(
          await hub.request(deviceId, "fs.write", {
            path,
            content,
            expectedSha256
          })
        )
    );

    server.registerTool(
      "execute_command",
      securedToolConfig(
        {
          title: "Execute command",
          description:
            "Execute a shell command on a connected computer. Windows defaults to PowerShell with Unicode-safe EncodedCommand; macOS defaults to zsh.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            command: z.string().min(1),
            cwd: z.string().optional(),
            shell: z.string().optional(),
            timeoutMs: z.number().int().min(1000).max(300000).optional()
          })
        },
        destructiveAnnotations
      ),
      async ({ deviceId, command, cwd, shell, timeoutMs }) =>
        textResult(
          await hub.request(
            deviceId,
            "shell.exec",
            { command, cwd, shell, timeoutMs },
            timeoutMs
          )
        )
    );

    server.registerTool(
      "execute_command_async",
      securedToolConfig(
        {
          title: "Execute command asynchronously",
          description:
            "Start a shell command asynchronously on a connected computer and return a jobId for status tracking.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            command: z.string().min(1),
            cwd: z.string().optional(),
            shell: z.string().optional(),
            timeoutMs: z.number().int().min(1000).optional()
          })
        },
        destructiveAnnotations
      ),
      async ({ deviceId, command, cwd, shell, timeoutMs }) =>
        textResult(
          await hub.request(deviceId, "job.start", { command, cwd, shell, timeoutMs })
        )
    );

    server.registerTool(
      "get_command_status",
      securedToolConfig(
        {
          title: "Get asynchronous command status",
          description:
            "Retrieve the current status and output lines of a running or completed asynchronous job.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            jobId: z.string().min(1),
            maxLines: z.number().int().min(1).max(500).optional()
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId, jobId, maxLines }) =>
        textResult(
          await hub.request(deviceId, "job.status", { jobId, maxLines })
        )
    );

    server.registerTool(
      "cancel_command",
      securedToolConfig(
        {
          title: "Cancel asynchronous command",
          description:
            "Cancel a running asynchronous command job on a connected computer.",
          inputSchema: z.object({
            deviceId: z.string().min(1),
            jobId: z.string().min(1)
          })
        },
        destructiveAnnotations
      ),
      async ({ deviceId, jobId }) =>
        textResult(
          await hub.request(deviceId, "job.cancel", { jobId })
        )
    );

    server.registerTool(
      "device_runtime_status",
      securedToolConfig(
        {
          title: "Device action runtime status",
          description:
            "Show the selected computer's long-lived Agent Guardian and replaceable action worker status.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        readOnlyAnnotations
      ),
      async ({ deviceId }) =>
        textResult(
          await hub.request(deviceId, "agent.runtime_status", undefined, 30_000)
        )
    );

    server.registerTool(
      "reload_device_runtime",
      securedToolConfig(
        {
          title: "Safely reload a device action runtime",
          description:
            "Typecheck, snapshot, health-check, and blue/green switch the selected computer's action worker while its Agent Guardian keeps the device connection alive.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        writeAnnotations
      ),
      async ({ deviceId }) =>
        textResult(
          await hub.request(deviceId, "agent.reload_runtime", undefined, 180_000)
        )
    );

    server.registerTool(
      "rollback_device_runtime",
      securedToolConfig(
        {
          title: "Rollback a device action runtime",
          description:
            "Switch the selected computer back to its previous known-good action worker without reconnecting the Agent Guardian.",
          inputSchema: z.object({
            deviceId: z.string().min(1)
          })
        },
        writeAnnotations
      ),
      async ({ deviceId }) =>
        textResult(
          await hub.request(
            deviceId,
            "agent.rollback_runtime",
            undefined,
            180_000
          )
        )
    );

    if (hub.runtimeStatus) {
      server.registerTool(
        "runtime_status",
        securedToolConfig(
          {
            title: "Nomsod runtime status",
            description:
              "Show the active runtime generation and self-healing supervisor state."
          },
          readOnlyAnnotations
        ),
        async () => textResult(await hub.runtimeStatus!())
      );
    }

    if (hub.reloadRuntime) {
      server.registerTool(
        "reload_runtime",
        securedToolConfig(
          {
            title: "Safely reload Nomsod runtime",
            description:
              "Create a candidate runtime snapshot, health-check it, and switch traffic only if healthy. The old runtime stays alive during cut-over so the MCP connection can finish this call."
          },
          writeAnnotations
        ),
        async () => textResult(await hub.reloadRuntime!())
      );
    }

    if (hub.rollbackRuntime) {
      server.registerTool(
        "rollback_runtime",
        securedToolConfig(
          {
            title: "Rollback Nomsod runtime",
            description:
              "Switch back to the previous known-good runtime release with a health-checked blue/green cut-over."
          },
          writeAnnotations
        ),
        async () => textResult(await hub.rollbackRuntime!())
      );
    }

    return server;
  }, {
    legacy: "stateless",
    maxRequestBodySize: MCP_MAX_REQUEST_BODY_BYTES,
    onerror: error => console.error("[mcp] handler error:", error)
  });
}
