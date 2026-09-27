import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { readUtf8TextFile, writeUtf8TextFile } from "../shared/text-codec.js";

const execFileAsync = promisify(execFile);

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function requiredString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`${key} is required`);
  return value;
}

function encodePowerShellCommand(command: string): string {
  const prelude = [
    "$ProgressPreference = \"SilentlyContinue\";",
    "$__nomsodUtf8 = New-Object System.Text.UTF8Encoding($false);",
    "[Console]::InputEncoding = $__nomsodUtf8;",
    "[Console]::OutputEncoding = $__nomsodUtf8;",
    "$OutputEncoding = $__nomsodUtf8;"
  ].join(" ");
  return Buffer.from(`${prelude} ${command}`, "utf16le").toString("base64");
}

export async function executeAction(method: string, rawParams: unknown): Promise<unknown> {
  const params = asObject(rawParams);

  switch (method) {
    case "system.info":
      return {
        hostname: os.hostname(),
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        cpuModel: os.cpus()[0]?.model ?? "unknown",
        cpuCores: os.cpus().length,
        memory: {
          totalBytes: os.totalmem(),
          freeBytes: os.freemem()
        },
        uptimeSeconds: os.uptime()
      };

    case "fs.list": {
      const target = requiredString(params, "path");
      const entries = await fs.readdir(target, { withFileTypes: true });
      return Promise.all(entries.map(async entry => {
        const full = path.join(target, entry.name);
        let stat: Awaited<ReturnType<typeof fs.stat>> | undefined;
        try { stat = await fs.stat(full); } catch {}
        return {
          name: entry.name,
          type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
          size: stat?.size ?? null,
          modifiedAt: stat?.mtime?.toISOString() ?? null
        };
      }));
    }

    case "fs.read": {
      const target = requiredString(params, "path");
      const text = await readUtf8TextFile(target);
      return {
        path: target,
        encoding: "utf-8",
        bom: text.hadBom,
        sha256: text.sha256,
        bytes: text.bytes,
        content: text.content
      };
    }

    case "fs.read_range": {
      const target = requiredString(params, "path");
      const text = await readUtf8TextFile(target);
      const lines = text.content.split(/\r\n|\n|\r/);
      const requestedStart = typeof params.startLine === "number" ? Math.trunc(params.startLine) : 1;
      const startLine = Math.min(Math.max(requestedStart, 1), Math.max(lines.length, 1));
      const requestedMax = typeof params.maxLines === "number" ? Math.trunc(params.maxLines) : 200;
      const maxLines = Math.min(Math.max(requestedMax, 1), 500);
      const slice = lines.slice(startLine - 1, startLine - 1 + maxLines);

      return {
        path: target,
        encoding: "utf-8",
        bom: text.hadBom,
        sha256: text.sha256,
        bytes: text.bytes,
        totalLines: lines.length,
        startLine,
        endLine: slice.length ? startLine + slice.length - 1 : startLine - 1,
        linesReturned: slice.length,
        complete: startLine === 1 && slice.length === lines.length,
        lines: slice.map((value, index) => ({ line: startLine + index, text: value }))
      };
    }

    case "fs.patch": {
      const target = requiredString(params, "path");
      const expectedSha256 = requiredString(params, "expectedSha256");
      if (!Array.isArray(params.replacements) || params.replacements.length === 0) {
        throw new Error("replacements must be a non-empty array");
      }

      const current = await readUtf8TextFile(target);
      if (current.sha256 !== expectedSha256) {
        throw new Error(
          `File changed since it was read: ${target}. Expected SHA-256 ${expectedSha256}, got ${current.sha256}.`
        );
      }

      let content = current.content;
      const applied: Array<{ oldText: string; expectedOccurrences: number; actualOccurrences: number }> = [];

      for (const raw of params.replacements) {
        const replacement = asObject(raw);
        const oldText = requiredString(replacement, "oldText");
        const newText = typeof replacement.newText === "string"
          ? replacement.newText
          : (() => { throw new Error("newText is required"); })();
        const expectedOccurrences = typeof replacement.expectedOccurrences === "number"
          ? Math.trunc(replacement.expectedOccurrences)
          : 1;

        if (expectedOccurrences < 1) throw new Error("expectedOccurrences must be >= 1");

        const actualOccurrences = content.split(oldText).length - 1;
        if (actualOccurrences !== expectedOccurrences) {
          throw new Error(
            `Patch occurrence mismatch for ${target}: expected ${expectedOccurrences}, found ${actualOccurrences}.`
          );
        }

        content = content.split(oldText).join(newText);
        applied.push({ oldText, expectedOccurrences, actualOccurrences });
      }

      const result = await writeUtf8TextFile(target, content, {
        expectedSha256,
        preserveBom: true
      });

      return { ...result, replacementsApplied: applied.length };
    }

    case "fs.write": {
      const target = requiredString(params, "path");
      const content = typeof params.content === "string" ? params.content : (() => { throw new Error("content is required"); })();
      const expectedSha256 = typeof params.expectedSha256 === "string" && params.expectedSha256
        ? params.expectedSha256
        : undefined;

      let exists = false;
      try {
        await fs.access(target);
        exists = true;
      } catch {}

      if (exists && !expectedSha256) {
        throw new Error(
          "Refusing to overwrite an existing text file without expectedSha256. " +
          "Read the file first and pass its sha256 back when writing."
        );
      }

      return writeUtf8TextFile(target, content, { expectedSha256, preserveBom: true });
    }

    case "shell.exec": {
      const command = requiredString(params, "command");
      const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : undefined;
      const timeoutMs = typeof params.timeoutMs === "number"
        ? Math.min(Math.max(params.timeoutMs, 1_000), 300_000)
        : 120_000;
      const requestedShell = typeof params.shell === "string" ? params.shell.toLowerCase() : "";
      let executable: string;
      let args: string[];

      if (process.platform === "win32") {
        if (requestedShell === "cmd") {
          executable = process.env.ComSpec || "cmd.exe";
          args = ["/d", "/s", "/c", `chcp 65001>nul & ${command}`];
        } else {
          executable = "powershell.exe";
          args = [
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            encodePowerShellCommand(command)
          ];
        }
      } else {
        executable = requestedShell === "bash" ? "/bin/bash" : "/bin/zsh";
        try { await fs.access(executable); } catch { executable = "/bin/sh"; }
        args = ["-lc", command];
      }

      try {
        const { stdout, stderr } = await execFileAsync(executable, args, {
          cwd,
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: 8 * 1024 * 1024,
          encoding: "utf8",
          env: {
            ...process.env,
            LANG: process.env.LANG || "C.UTF-8",
            LC_ALL: process.env.LC_ALL || "C.UTF-8"
          }
        });
        return { exitCode: 0, stdout, stderr, shell: executable, encoding: "utf-8" };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string; code?: number | string };
        return {
          exitCode: typeof err.code === "number" ? err.code : 1,
          stdout: err.stdout ?? "",
          stderr: err.stderr ?? err.message,
          shell: executable,
          encoding: "utf-8"
        };
      }
    }

    default:
      throw new Error(`Unsupported agent method: ${method}`);
  }
}
