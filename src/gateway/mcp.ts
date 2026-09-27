import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { z } from "zod";
import type { ComputerHub } from "./hub-client.js";

function textResult(value: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }]
  };
}

export function createNomsodMcpHandler(hub: ComputerHub) {
  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "nomsod-mcp", version: "0.1.0" },
      { capabilities: { tools: {} } }
    );

    server.registerTool(
      "list_computers",
      {
        title: "List connected computers",
        description: "List computers currently connected to Nomsod MCP. Device names are discovered at runtime and are never hardcoded."
      },
      async () => textResult({ computers: await hub.listDevices() })
    );

    server.registerTool(
      "get_system_info",
      {
        title: "Get computer system information",
        description: "Read system information from a connected computer.",
        inputSchema: z.object({
          deviceId: z.string().min(1)
        })
      },
      async ({ deviceId }) => textResult(await hub.request(deviceId, "system.info"))
    );

    server.registerTool(
      "list_directory",
      {
        title: "List directory",
        description: "List files and directories on a connected computer.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          path: z.string().min(1)
        })
      },
      async ({ deviceId, path }) => textResult(await hub.request(deviceId, "fs.list", { path }))
    );

    server.registerTool(
      "read_text_file",
      {
        title: "Read UTF-8 text file",
        description: "Read a UTF-8 text file. The result includes SHA-256 for safe compare-and-write updates.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          path: z.string().min(1)
        })
      },
      async ({ deviceId, path }) => textResult(await hub.request(deviceId, "fs.read", { path }))
    );

    server.registerTool(
      "read_text_range",
      {
        title: "Read UTF-8 text range",
        description: "Read a bounded line range from a UTF-8 file. Returns totalLines, linesReturned, complete and SHA-256 so large files are never mistaken for complete reads.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          path: z.string().min(1),
          startLine: z.number().int().min(1).optional(),
          maxLines: z.number().int().min(1).max(500).optional()
        })
      },
      async ({ deviceId, path, startLine, maxLines }) =>
        textResult(await hub.request(deviceId, "fs.read_range", { path, startLine, maxLines }))
    );

    server.registerTool(
      "patch_text_file",
      {
        title: "Patch UTF-8 text file safely",
        description: "Apply exact text replacements to a UTF-8 file using an expected SHA-256. Each replacement must match the expected occurrence count, preventing stale or partial-read overwrites.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          path: z.string().min(1),
          expectedSha256: z.string().length(64),
          replacements: z.array(z.object({
            oldText: z.string().min(1),
            newText: z.string(),
            expectedOccurrences: z.number().int().min(1).optional()
          })).min(1)
        })
      },
      async ({ deviceId, path, expectedSha256, replacements }) =>
        textResult(await hub.request(deviceId, "fs.patch", { path, expectedSha256, replacements }))
    );

    server.registerTool(
      "write_text_file",
      {
        title: "Safely write UTF-8 text file",
        description: "Create a UTF-8 text file or safely overwrite an existing one. Existing files require expectedSha256 from read_text_file to prevent stale writes and encoding corruption.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          path: z.string().min(1),
          content: z.string(),
          expectedSha256: z.string().length(64).optional()
        })
      },
      async ({ deviceId, path, content, expectedSha256 }) =>
        textResult(await hub.request(deviceId, "fs.write", { path, content, expectedSha256 }))
    );

    server.registerTool(
      "execute_command",
      {
        title: "Execute command",
        description: "Execute a shell command on a connected computer. Windows defaults to PowerShell with Unicode-safe EncodedCommand; macOS defaults to zsh.",
        inputSchema: z.object({
          deviceId: z.string().min(1),
          command: z.string().min(1),
          cwd: z.string().optional(),
          shell: z.string().optional(),
          timeoutMs: z.number().int().min(1000).max(300000).optional()
        })
      },
      async ({ deviceId, command, cwd, shell, timeoutMs }) =>
        textResult(await hub.request(deviceId, "shell.exec", { command, cwd, shell, timeoutMs }, timeoutMs))
    );

    server.registerTool(
      "device_runtime_status",
      {
        title: "Device action runtime status",
        description: "Show the selected computer's long-lived Agent Guardian and replaceable action worker status.",
        inputSchema: z.object({
          deviceId: z.string().min(1)
        })
      },
      async ({ deviceId }) =>
        textResult(await hub.request(deviceId, "agent.runtime_status", undefined, 30_000))
    );

    server.registerTool(
      "reload_device_runtime",
      {
        title: "Safely reload a device action runtime",
        description: "Typecheck, snapshot, health-check, and blue/green switch the selected computer's action worker while its Agent Guardian keeps the device connection alive.",
        inputSchema: z.object({
          deviceId: z.string().min(1)
        })
      },
      async ({ deviceId }) =>
        textResult(await hub.request(deviceId, "agent.reload_runtime", undefined, 180_000))
    );

    server.registerTool(
      "rollback_device_runtime",
      {
        title: "Rollback a device action runtime",
        description: "Switch the selected computer back to its previous known-good action worker without reconnecting the Agent Guardian.",
        inputSchema: z.object({
          deviceId: z.string().min(1)
        })
      },
      async ({ deviceId }) =>
        textResult(await hub.request(deviceId, "agent.rollback_runtime", undefined, 180_000))
    );

    if (hub.runtimeStatus) {
      server.registerTool(
        "runtime_status",
        {
          title: "Nomsod runtime status",
          description: "Show the active runtime generation and self-healing supervisor state."
        },
        async () => textResult(await hub.runtimeStatus!())
      );
    }

    if (hub.reloadRuntime) {
      server.registerTool(
        "reload_runtime",
        {
          title: "Safely reload Nomsod runtime",
          description: "Create a candidate runtime snapshot, health-check it, and switch traffic only if healthy. The old runtime stays alive during cut-over so the MCP connection can finish this call."
        },
        async () => textResult(await hub.reloadRuntime!())
      );
    }

    if (hub.rollbackRuntime) {
      server.registerTool(
        "rollback_runtime",
        {
          title: "Rollback Nomsod runtime",
          description: "Switch back to the previous known-good runtime release with a health-checked blue/green cut-over."
        },
        async () => textResult(await hub.rollbackRuntime!())
      );
    }

    return server;
  }, {
    legacy: "stateless",
    onerror: error => console.error("[mcp] handler error:", error)
  });
}
