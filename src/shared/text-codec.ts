import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF16LE_BOM = Buffer.from([0xff, 0xfe]);
const UTF16BE_BOM = Buffer.from([0xfe, 0xff]);

export interface Utf8TextFile {
  content: string;
  hadBom: boolean;
  sha256: string;
  bytes: number;
}

function startsWith(buffer: Buffer, prefix: Buffer): boolean {
  return buffer.length >= prefix.length && buffer.subarray(0, prefix.length).equals(prefix);
}

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

export function decodeStrictUtf8(buffer: Buffer, filePath = "file"): Utf8TextFile {
  if (startsWith(buffer, UTF16LE_BOM) || startsWith(buffer, UTF16BE_BOM)) {
    throw new Error(`Refusing to edit non-UTF-8 text file: ${filePath} is UTF-16. Convert it explicitly first.`);
  }

  const hadBom = startsWith(buffer, UTF8_BOM);
  const body = hadBom ? buffer.subarray(UTF8_BOM.length) : buffer;

  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    throw new Error(
      `Refusing to edit text file with invalid UTF-8 bytes: ${filePath}. ` +
      "This prevents mojibake/data loss from Windows ANSI or legacy code pages."
    );
  }

  return { content, hadBom, sha256: sha256(buffer), bytes: buffer.length };
}

export async function readUtf8TextFile(filePath: string): Promise<Utf8TextFile> {
  return decodeStrictUtf8(await fs.readFile(filePath), filePath);
}

export async function writeUtf8TextFile(
  filePath: string,
  content: string,
  options?: { expectedSha256?: string; preserveBom?: boolean }
): Promise<{ path: string; bytesWritten: number; sha256: string; bom: boolean }> {
  let hadBom = false;

  try {
    const current = await readUtf8TextFile(filePath);
    hadBom = current.hadBom;
    if (options?.expectedSha256 && current.sha256 !== options.expectedSha256) {
      throw new Error(
        `File changed since it was read: ${filePath}. Expected SHA-256 ${options.expectedSha256}, got ${current.sha256}.`
      );
    }
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw error;
  }

  const includeBom = options?.preserveBom !== false && hadBom;
  const text = Buffer.from(content, "utf8");
  const bytes = includeBom ? Buffer.concat([UTF8_BOM, text]) : text;

  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.nomsod-${process.pid}-${Date.now()}.tmp`;
  await fs.writeFile(tempPath, bytes);

  try {
    await fs.rename(tempPath, filePath);
  } catch {
    // Windows does not always replace an existing destination atomically.
    // The temporary file still guarantees bytes were encoded correctly before replacement.
    await fs.rm(filePath, { force: true });
    await fs.rename(tempPath, filePath);
  }

  return {
    path: filePath,
    bytesWritten: bytes.length,
    sha256: sha256(bytes),
    bom: includeBom
  };
}
