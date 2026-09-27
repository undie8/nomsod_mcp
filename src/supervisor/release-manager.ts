import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

export interface RuntimeRelease {
  id: string;
  dir: string;
  main: string;
  createdAt: string;
}

interface RuntimeStateFile {
  lastGoodReleaseId?: string;
  previousGoodReleaseId?: string;
  updatedAt?: string;
}

export interface ReleaseManagerOptions {
  releasesDirName?: string;
  stateFileName?: string;
  entryRelativePath?: string;
}

interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

export class ReleaseManager {
  readonly releasesDir: string;
  readonly statePath: string;
  readonly entryRelativePath: string;
  readonly builtEntryRelativePath: string;

  constructor(
    readonly root: string,
    options: ReleaseManagerOptions = {}
  ) {
    this.releasesDir = path.join(root, "data", options.releasesDirName || "releases");
    this.statePath = path.join(root, "data", options.stateFileName || "runtime-state.json");
    this.entryRelativePath = options.entryRelativePath || path.join("src", "gateway", "main.ts");

    const fromSrc = path.relative("src", this.entryRelativePath);
    if (fromSrc.startsWith("..") || path.isAbsolute(fromSrc)) {
      throw new Error(`Release entry must be under src/: ${this.entryRelativePath}`);
    }

    this.builtEntryRelativePath = path.join(
      "dist",
      fromSrc.replace(/\.tsx?$/i, ".js")
    );
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.releasesDir, { recursive: true });
  }

  private async runProcess(
    executable: string,
    args: string[],
    cwd: string,
    timeoutMs: number
  ): Promise<CommandResult> {
    return new Promise(resolve => {
      const child = spawn(executable, args, {
        cwd,
        windowsHide: true,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"]
      });

      let stdout = "";
      let stderr = "";
      let settled = false;

      const finish = (ok: boolean) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok, stdout, stderr });
      };

      const timer = setTimeout(() => {
        stderr += `\nCommand timed out after ${timeoutMs}ms`;
        try { child.kill("SIGKILL"); } catch {}
        finish(false);
      }, timeoutMs);

      child.stdout?.on("data", chunk => { stdout += chunk.toString("utf8"); });
      child.stderr?.on("data", chunk => { stderr += chunk.toString("utf8"); });
      child.on("error", error => {
        stderr += error.message;
        finish(false);
      });
      child.on("exit", code => finish(code === 0));
    });
  }

  async runTypecheck(timeoutMs = 120_000): Promise<CommandResult> {
    const tscCli = path.join(this.root, "node_modules", "typescript", "bin", "tsc");
    const project = path.join(this.root, "tsconfig.json");

    return this.runProcess(
      process.execPath,
      [tscCli, "--noEmit", "-p", project],
      this.root,
      timeoutMs
    );
  }

  private async buildSnapshot(dir: string, timeoutMs = 120_000): Promise<void> {
    const tscCli = path.join(this.root, "node_modules", "typescript", "bin", "tsc");
    const project = path.join(dir, "tsconfig.build.json");
    const outDir = path.join(dir, "dist");

    const built = await this.runProcess(
      process.execPath,
      [tscCli, "-p", project, "--outDir", outDir],
      dir,
      timeoutMs
    );

    if (!built.ok) {
      throw new Error(
        "Release snapshot build failed:\n" +
        built.stdout.slice(-4_000) +
        "\n" +
        built.stderr.slice(-8_000)
      );
    }

    const builtMain = path.join(dir, this.builtEntryRelativePath);
    await fs.access(builtMain);
  }

  async createSnapshot(): Promise<RuntimeRelease> {
    const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14)}-${randomBytes(4).toString("hex")}`;
    const dir = path.join(this.releasesDir, id);
    const createdAt = new Date().toISOString();

    await fs.mkdir(dir, { recursive: true });
    await fs.cp(path.join(this.root, "src"), path.join(dir, "src"), {
      recursive: true,
      force: false,
      errorOnExist: true
    });

    for (const file of [
      "package.json",
      "package-lock.json",
      "tsconfig.json",
      "tsconfig.build.json"
    ]) {
      await fs.copyFile(path.join(this.root, file), path.join(dir, file));
    }

    await this.buildSnapshot(dir);

    await fs.writeFile(
      path.join(dir, "release.json"),
      JSON.stringify({
        id,
        createdAt,
        entryRelativePath: this.entryRelativePath,
        builtEntryRelativePath: this.builtEntryRelativePath
      }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );

    return {
      id,
      dir,
      main: path.join(dir, this.builtEntryRelativePath),
      createdAt
    };
  }

  async getRelease(id: string): Promise<RuntimeRelease | undefined> {
    const dir = path.join(this.releasesDir, id);
    const main = path.join(dir, this.builtEntryRelativePath);

    try {
      await fs.access(main);
    } catch {
      return undefined;
    }

    let createdAt = new Date(0).toISOString();
    try {
      const metadata = JSON.parse(await fs.readFile(path.join(dir, "release.json"), "utf8"));
      if (typeof metadata.createdAt === "string") createdAt = metadata.createdAt;
    } catch {}

    return { id, dir, main, createdAt };
  }

  private async readState(): Promise<RuntimeStateFile> {
    try {
      return JSON.parse(await fs.readFile(this.statePath, "utf8")) as RuntimeStateFile;
    } catch {
      return {};
    }
  }

  async getLastGood(): Promise<RuntimeRelease | undefined> {
    const state = await this.readState();
    return state.lastGoodReleaseId
      ? this.getRelease(state.lastGoodReleaseId)
      : undefined;
  }

  async getPreviousGood(): Promise<RuntimeRelease | undefined> {
    const state = await this.readState();
    return state.previousGoodReleaseId
      ? this.getRelease(state.previousGoodReleaseId)
      : undefined;
  }

  async markLastGood(release: RuntimeRelease, previous?: RuntimeRelease): Promise<void> {
    await fs.mkdir(path.dirname(this.statePath), { recursive: true });
    const existing = await this.readState();
    const temp = this.statePath + ".tmp";
    const value: RuntimeStateFile = {
      lastGoodReleaseId: release.id,
      previousGoodReleaseId: previous?.id ?? existing.previousGoodReleaseId,
      updatedAt: new Date().toISOString()
    };

    await fs.writeFile(temp, JSON.stringify(value, null, 2), {
      encoding: "utf8",
      mode: 0o600
    });

    try { await fs.rm(this.statePath, { force: true }); } catch {}
    await fs.rename(temp, this.statePath);
  }
}
