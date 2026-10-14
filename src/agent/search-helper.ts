import { promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SearchMatch, SearchParams, SearchResult } from "../shared/search-types.js";

const DEFAULT_IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".turbo",
  ".cache",
  "coverage",
  "tmp"
]);

const DEFAULT_MAX_RESULTS = 50;
const ABSOLUTE_MAX_RESULTS = 200;
const DEFAULT_MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const BINARY_CHECK_BYTES = 8192; // 8KB check for null bytes

function compileFileFilter(pattern?: string): (fileName: string) => boolean {
  if (!pattern) return () => true;

  const patterns = pattern
    .split(",")
    .map(p => p.trim())
    .filter(Boolean);

  if (patterns.length === 0) return () => true;

  const regexes = patterns.map(p => {
    const clean = p.startsWith("*.") ? p.slice(1) : p.startsWith(".") ? p : `.${p}`;
    const escaped = clean.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp(`${escaped}$`, "i");
  });

  return (fileName: string) => regexes.some(rx => rx.test(fileName));
}

function isBinaryBuffer(buffer: Buffer): boolean {
  const checkLength = Math.min(buffer.length, BINARY_CHECK_BYTES);
  for (let i = 0; i < checkLength; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function normalizeFilePath(filePath: string, rootPath: string): string {
  const rel = path.relative(rootPath, filePath);
  return rel.split(path.sep).join("/");
}

async function searchFilesWorker(
  currentDir: string,
  rootPath: string,
  queryRegex: RegExp,
  fileFilter: (name: string) => boolean,
  maxResults: number,
  maxFileSize: number,
  ignoredDirs: Set<string>,
  state: { totalFilesScanned: number; matches: SearchMatch[]; truncated: boolean }
): Promise<void> {
  if (state.matches.length >= maxResults || state.truncated) return;

  let entries;
  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch {
    return;
  }

  const subDirs: string[] = [];

  for (const entry of entries) {
    if (state.matches.length >= maxResults) {
      state.truncated = true;
      return;
    }

    const fullPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirs.has(entry.name) || (entry.name.startsWith(".") && entry.name !== "." && entry.name !== "..")) {
        continue;
      }
      subDirs.push(fullPath);
    } else if (entry.isFile()) {
      if (!fileFilter(entry.name)) continue;

      let stats;
      try {
        stats = await fs.stat(fullPath);
      } catch {
        continue;
      }

      if (stats.size > maxFileSize) continue;

      state.totalFilesScanned++;

      try {
        const buffer = await fs.readFile(fullPath);
        if (isBinaryBuffer(buffer)) continue;

        const content = buffer.toString("utf8");
        const lines = content.split(/\r\n|\n|\r/);

        for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
          if (state.matches.length >= maxResults) {
            state.truncated = true;
            break;
          }

          const lineText = lines[lineIdx];
          queryRegex.lastIndex = 0;
          const matchResult = queryRegex.exec(lineText);

          if (matchResult) {
            const column = matchResult.index + 1;
            const preview = lineText.trim();
            const relFile = normalizeFilePath(fullPath, rootPath);

            state.matches.push({
              file: relFile,
              line: lineIdx + 1,
              column,
              preview: preview.length > 160 ? preview.slice(0, 160) + "..." : preview
            });

            if (state.matches.length >= maxResults) {
              state.truncated = true;
              break;
            }
          }
        }
      } catch {
        continue;
      }
    }
  }

  for (const subDir of subDirs) {
    if (state.matches.length >= maxResults || state.truncated) {
      state.truncated = true;
      break;
    }
    await searchFilesWorker(
      subDir,
      rootPath,
      queryRegex,
      fileFilter,
      maxResults,
      maxFileSize,
      ignoredDirs,
      state
    );
  }
}

export async function searchFiles(params: SearchParams): Promise<SearchResult> {
  const startTime = performance.now();
  const rootPath = path.resolve(params.path || process.cwd());

  const rawMaxResults = typeof params.maxResults === "number" ? params.maxResults : DEFAULT_MAX_RESULTS;
  const maxResults = Math.min(Math.max(Math.trunc(rawMaxResults), 1), ABSOLUTE_MAX_RESULTS);

  let queryRegex: RegExp;
  if (params.isRegex) {
    const flags = params.caseSensitive ? "g" : "gi";
    queryRegex = new RegExp(params.query, flags);
  } else {
    const escaped = params.query.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    const flags = params.caseSensitive ? "g" : "gi";
    queryRegex = new RegExp(escaped, flags);
  }

  const fileFilter = compileFileFilter(params.pattern);

  const state = {
    totalFilesScanned: 0,
    matches: [] as SearchMatch[],
    truncated: false
  };

  await searchFilesWorker(
    rootPath,
    rootPath,
    queryRegex,
    fileFilter,
    maxResults,
    DEFAULT_MAX_FILE_SIZE,
    DEFAULT_IGNORED_DIRS,
    state
  );

  const endTime = performance.now();
  const durationMs = Math.round(endTime - startTime);

  return {
    matches: state.matches,
    totalMatches: state.matches.length,
    totalFilesScanned: state.totalFilesScanned,
    durationMs,
    truncated: state.truncated
  };
}
