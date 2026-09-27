import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readUtf8TextFile, writeUtf8TextFile } from "../src/shared/text-codec.js";

const dirs: string[] = [];

async function tempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nomsod-mcp-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => fs.rm(dir, { recursive: true, force: true })));
});

describe("UTF-8 text safety", () => {
  it("round-trips Thai text and preserves UTF-8", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "thai.txt");
    const content = "ทดสอบภาษาไทย สวัสดี 😀";

    const written = await writeUtf8TextFile(file, content);
    const read = await readUtf8TextFile(file);

    expect(read.content).toBe(content);
    expect(read.sha256).toBe(written.sha256);
    expect(read.hadBom).toBe(false);
  });

  it("rejects stale compare-and-write hashes", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "stale.txt");

    const first = await writeUtf8TextFile(file, "one");
    await writeUtf8TextFile(file, "two", { expectedSha256: first.sha256 });

    await expect(
      writeUtf8TextFile(file, "three", { expectedSha256: first.sha256 })
    ).rejects.toThrow(/File changed since it was read/);
  });

  it("refuses invalid UTF-8 bytes instead of producing mojibake", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "legacy.bin");

    await fs.writeFile(file, Buffer.from([0x80, 0x81, 0x82]));
    await expect(readUtf8TextFile(file)).rejects.toThrow(/invalid UTF-8 bytes/);
  });

  it("refuses UTF-16 text until explicitly converted", async () => {
    const dir = await tempDir();
    const file = path.join(dir, "utf16.txt");

    await fs.writeFile(file, Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("hello", "utf16le")
    ]));

    await expect(readUtf8TextFile(file)).rejects.toThrow(/UTF-16/);
  });
});
