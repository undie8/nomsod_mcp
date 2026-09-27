import { promises as fs } from "node:fs";
import path from "node:path";

function parseValue(raw: string): string {
  const value = raw.trim();

  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    const inner = value.slice(1, -1);
    return value.startsWith('"')
      ? inner
          .replaceAll("\\n", "\n")
          .replaceAll("\\r", "\r")
          .replaceAll("\\t", "\t")
          .replaceAll('\\"', '"')
          .replaceAll("\\\\", "\\")
      : inner;
  }

  const comment = value.search(/\s+#/);
  return comment >= 0 ? value.slice(0, comment).trimEnd() : value;
}

export async function loadDotEnv(): Promise<string | undefined> {
  const file = process.env.NOMSOD_ENV_FILE?.trim() || path.resolve(".env");

  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") return undefined;
    throw error;
  }

  for (const rawLine of content.split(/\r\n|\n|\r/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const normalized = line.startsWith("export ") ? line.slice(7).trim() : line;
    const equals = normalized.indexOf("=");
    if (equals <= 0) continue;

    const key = normalized.slice(0, equals).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    if (process.env[key] !== undefined) continue;

    process.env[key] = parseValue(normalized.slice(equals + 1));
  }

  return file;
}
