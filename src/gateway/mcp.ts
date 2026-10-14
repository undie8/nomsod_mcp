import { McpServer, createMcpHandler, requireScopes } from "@modelcontextprotocol/server";
import { z } from "zod";
import { getNomsodVersion } from "../shared/version.js";
import type { ComputerHub } from "./hub-client.js";

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

function securedToolConfig<T extends Record<string, unknown>>(
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

  return createMcpHandler(() => {
    const server = new McpServer(
      { name: "nomsod-mcp", version },
      {
        capabilities: { tools: {} },
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
    onerror: error => console.error("[mcp] handler error:", error)
  });
}
