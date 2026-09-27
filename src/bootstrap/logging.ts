import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import path from "node:path";
import util from "node:util";

const MAX_LOG_BYTES = 10 * 1024 * 1024;

function rotate(logFile: string): void {
  try {
    if (!existsSync(logFile) || statSync(logFile).size < MAX_LOG_BYTES) return;
    const previous = logFile + ".1";
    try { renameSync(logFile, previous); }
    catch {}
  } catch {}
}

export function installFileLogging(role: string): string {
  const logDir = process.env.NOMSOD_LOG_DIR?.trim() || path.resolve("data", "logs");
  mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, `${role}.log`);
  rotate(logFile);

  const originals = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  const write = (level: "INFO" | "WARN" | "ERROR", args: unknown[]) => {
    const line = `[${new Date().toISOString()}] [${level}] ${util.format(...args)}\n`;
    try { appendFileSync(logFile, line, { encoding: "utf8" }); }
    catch {}
  };

  console.log = (...args: unknown[]) => {
    originals.log(...args);
    write("INFO", args);
  };
  console.warn = (...args: unknown[]) => {
    originals.warn(...args);
    write("WARN", args);
  };
  console.error = (...args: unknown[]) => {
    originals.error(...args);
    write("ERROR", args);
  };

  return logFile;
}
