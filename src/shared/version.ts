import { readFileSync } from "node:fs";
import path from "node:path";

export function getNomsodVersion(root = process.cwd()): string {
  const fromEnv = process.env.NOMSOD_VERSION?.trim();
  if (fromEnv) return fromEnv;

  try {
    const value = readFileSync(path.join(root, "VERSION"), "utf8").trim();
    if (value) return value;
  } catch {}

  return "0.0.0";
}
