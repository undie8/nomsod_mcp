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

export class ReleaseManager {
  readonly releasesDir: string;
  readonly statePath: string;

  constructor(readonly root: string) {
    this.releasesDir = path.join(root, "data", "releases");
    this.statePath = path.join(root, "data", "runtime-state.json");
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.releasesDir, { recursive: true });
  }

  async runTypecheck(timeoutMs = 120_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    const executable = process.platform === "win32"
      ? (process.env.ComSpec || "cmd.exe")
      : "npm";
    const args = process.platform === "win32"
      ? ["/d", "/s", "/c", "npm run typecheck"]
      : ["run", "typecheck"];

    return new Promise(resolve => {
      const child = spawn(executable, args, {
        cwd: this.root,
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
        stderr += `\nTypecheck timed out after ${timeoutMs}ms`;
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

    for (const file of ["package.json", "package-lock.json", "tsconfig.json"]) {
      try { await fs.copyFile(path.join(this.root, file), path.join(dir, file)); } catch {}
    }

    await fs.writeFile(
      path.join(dir, "release.json"),
      JSON.stringify({ id, createdAt }, null, 2),
      { encoding: "utf8", mode: 0o600 }
    );

    return {
      id,
      dir,
      main: path.join(dir, "src", "gateway", "main.ts"),
      createdAt
    };
  }

  async getRelease(id: string): Promise<RuntimeRelease | undefined> {
    const dir = path.join(this.releasesDir, id);
    const main = path.join(dir, "src", "gateway", "main.ts");

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
