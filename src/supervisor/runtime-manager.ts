import { spawn, type ChildProcess } from "node:child_process";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import type { RuntimeRelease } from "./release-manager.js";
import { ReleaseManager } from "./release-manager.js";

interface ManagedRuntime extends RuntimeRelease {
  port: number;
  process: ChildProcess;
  inFlight: number;
  draining: boolean;
  plannedStop: boolean;
}

export class RuntimeManager {
  private active?: ManagedRuntime;
  private readonly draining = new Map<string, ManagedRuntime>();
  private reloadPromise?: Promise<any>;
  private shuttingDown = false;

  constructor(
    private readonly root: string,
    private readonly controlPort: number,
    private readonly controlKey: string,
    private readonly runtimePorts: [number, number],
    private readonly releaseManager: ReleaseManager,
    private readonly drainTimeoutMs = 300_000
  ) {}

  private summary(runtime: ManagedRuntime | undefined) {
    if (!runtime) return null;
    return {
      id: runtime.id,
      port: runtime.port,
      pid: runtime.process.pid ?? null,
      createdAt: runtime.createdAt,
      inFlight: runtime.inFlight,
      draining: runtime.draining,
      alive: runtime.process.exitCode === null && !runtime.process.killed
    };
  }

  status() {
    return {
      active: this.summary(this.active),
      draining: [...this.draining.values()].map(runtime => this.summary(runtime)),
      reloadInProgress: !!this.reloadPromise
    };
  }

  private startRuntime(release: RuntimeRelease, runtimePort: number): ManagedRuntime {
    const proc = spawn(
      process.execPath,
      [release.main],
      {
        cwd: this.root,
        windowsHide: true,
        env: {
          ...process.env,
          NOMSOD_INTERNAL_PORT: String(runtimePort),
          NOMSOD_CONTROL_URL: `http://127.0.0.1:${this.controlPort}`,
          NOMSOD_CONTROL_KEY: this.controlKey
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );

    const runtime: ManagedRuntime = {
      ...release,
      port: runtimePort,
      process: proc,
      inFlight: 0,
      draining: false,
      plannedStop: false
    };

    proc.stdout?.on("data", chunk => process.stdout.write(`[runtime:${release.id}] ${chunk.toString("utf8")}`));
    proc.stderr?.on("data", chunk => process.stderr.write(`[runtime:${release.id}] ${chunk.toString("utf8")}`));

    proc.on("exit", (code, signal) => {
      console.warn(`[supervisor] runtime ${release.id} exited code=${code} signal=${signal || "-"}`);
      if (runtime.plannedStop || this.shuttingDown) return;
      if (this.active?.id !== runtime.id) return;

      this.active = undefined;
      setTimeout(() => {
        void this.restartLastGood(release, runtimePort);
      }, 1_000);
    });

    return runtime;
  }

  private async restartLastGood(release: RuntimeRelease, port: number): Promise<void> {
    if (this.shuttingDown || this.active) return;

    console.warn(`[supervisor] restarting last-good runtime ${release.id}`);
    const restarted = this.startRuntime(release, port);

    if (await this.waitHealthy(restarted, 15_000)) {
      this.active = restarted;
      console.log(`[supervisor] runtime ${release.id} recovered`);
      return;
    }

    restarted.plannedStop = true;
    try { restarted.process.kill("SIGKILL"); } catch {}
    console.error("[supervisor] runtime recovery failed; public gateway remains online");
  }

  private async waitHealthy(runtime: ManagedRuntime, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (runtime.process.exitCode !== null) return false;
      try {
        const response = await fetch(`http://127.0.0.1:${runtime.port}/health`, {
          signal: AbortSignal.timeout(1_000)
        });
        if (response.ok) {
          const body = await response.json() as any;
          if (body?.ok === true) return true;
        }
      } catch {}

      await new Promise(resolve => setTimeout(resolve, 250));
    }

    return false;
  }

  private drainAndStop(runtime: ManagedRuntime): void {
    runtime.draining = true;
    this.draining.set(runtime.id, runtime);
    const deadline = Date.now() + this.drainTimeoutMs;

    const check = () => {
      if (runtime.inFlight <= 0 || Date.now() >= deadline || this.shuttingDown) {
        runtime.plannedStop = true;
        try { runtime.process.kill("SIGTERM"); } catch {}

        setTimeout(() => {
          if (runtime.process.exitCode === null) {
            try { runtime.process.kill("SIGKILL"); } catch {}
          }
        }, 5_000).unref();

        this.draining.delete(runtime.id);
        return;
      }

      setTimeout(check, 500).unref();
    };

    setTimeout(check, 500).unref();
  }

  async initialize(): Promise<void> {
    await this.releaseManager.initialize();

    let release = await this.releaseManager.getLastGood();
    if (!release) {
      const checked = await this.releaseManager.runTypecheck();
      if (!checked.ok) {
        throw new Error("Initial runtime typecheck failed:\n" + checked.stderr.slice(-8_000));
      }
      release = await this.releaseManager.createSnapshot();
    }

    let runtime = this.startRuntime(release, this.runtimePorts[0]);

    if (!(await this.waitHealthy(runtime, 20_000))) {
      runtime.plannedStop = true;
      try { runtime.process.kill("SIGKILL"); } catch {}

      console.warn("[supervisor] last-good runtime failed; trying current workspace");
      const checked = await this.releaseManager.runTypecheck();
      if (!checked.ok) throw new Error("Workspace typecheck failed and last-good runtime could not start.");

      release = await this.releaseManager.createSnapshot();
      runtime = this.startRuntime(release, this.runtimePorts[0]);

      if (!(await this.waitHealthy(runtime, 20_000))) {
        runtime.plannedStop = true;
        try { runtime.process.kill("SIGKILL"); } catch {}
        throw new Error("No healthy runtime could be started.");
      }
    }

    this.active = runtime;
    await this.releaseManager.markLastGood(release);
    console.log(`[supervisor] active runtime ${runtime.id} pid=${runtime.process.pid}`);
  }

  async reload(): Promise<any> {
    if (this.reloadPromise) return this.reloadPromise;

    this.reloadPromise = (async () => {
      console.log("[supervisor] runtime reload requested; running typecheck");
      const checked = await this.releaseManager.runTypecheck();

      if (!checked.ok) {
        return {
          ok: false,
          switched: false,
          stage: "typecheck",
          active: this.summary(this.active),
          stdout: checked.stdout.slice(-8_000),
          stderr: checked.stderr.slice(-8_000)
        };
      }

      const candidateRelease = await this.releaseManager.createSnapshot();
      const candidatePort = this.active?.port === this.runtimePorts[0]
        ? this.runtimePorts[1]
        : this.runtimePorts[0];
      const candidate = this.startRuntime(candidateRelease, candidatePort);

      if (!(await this.waitHealthy(candidate, 20_000))) {
        candidate.plannedStop = true;
        try { candidate.process.kill("SIGKILL"); } catch {}

        return {
          ok: false,
          switched: false,
          stage: "candidate-health",
          candidate: candidateRelease.id,
          active: this.summary(this.active)
        };
      }

      const previous = this.active;
      this.active = candidate;
      await this.releaseManager.markLastGood(candidateRelease, previous);

      if (previous) this.drainAndStop(previous);

      console.log(`[supervisor] cut-over complete: ${previous?.id || "none"} -> ${candidate.id}`);

      return {
        ok: true,
        switched: true,
        previous: this.summary(previous),
        active: this.summary(candidate),
        rollbackAvailable: !!previous
      };
    })();

    try {
      return await this.reloadPromise;
    } finally {
      this.reloadPromise = undefined;
    }
  }

  async rollback(): Promise<any> {
    if (this.reloadPromise) return this.reloadPromise;

    this.reloadPromise = (async () => {
      const target = await this.releaseManager.getPreviousGood();
      if (!target) {
        return {
          ok: false,
          switched: false,
          stage: "no-rollback-release",
          active: this.summary(this.active)
        };
      }

      if (this.active?.id === target.id) {
        return {
          ok: true,
          switched: false,
          stage: "already-active",
          active: this.summary(this.active)
        };
      }

      const candidatePort = this.active?.port === this.runtimePorts[0]
        ? this.runtimePorts[1]
        : this.runtimePorts[0];
      const candidate = this.startRuntime(target, candidatePort);

      if (!(await this.waitHealthy(candidate, 20_000))) {
        candidate.plannedStop = true;
        try { candidate.process.kill("SIGKILL"); } catch {}

        return {
          ok: false,
          switched: false,
          stage: "rollback-health",
          target: target.id,
          active: this.summary(this.active)
        };
      }

      const previous = this.active;
      this.active = candidate;
      await this.releaseManager.markLastGood(target, previous);

      if (previous) this.drainAndStop(previous);

      console.log(`[supervisor] rollback complete: ${previous?.id || "none"} -> ${candidate.id}`);

      return {
        ok: true,
        switched: true,
        previous: this.summary(previous),
        active: this.summary(candidate)
      };
    })();

    try {
      return await this.reloadPromise;
    } finally {
      this.reloadPromise = undefined;
    }
  }

  proxy(req: IncomingMessage, res: ServerResponse): void {
    const runtime = this.active;

    if (!runtime) {
      res.writeHead(503, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store"
      });
      res.end(JSON.stringify({
        error: "runtime_unavailable",
        message: "Nomsod supervisor is online but no healthy runtime is active."
      }));
      return;
    }

    runtime.inFlight += 1;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      runtime.inFlight = Math.max(0, runtime.inFlight - 1);
    };

    const headers = { ...req.headers };
    delete headers.host;
    delete headers.authorization;

    const upstream = http.request({
      hostname: "127.0.0.1",
      port: runtime.port,
      path: req.url,
      method: req.method,
      headers: {
        ...headers,
        host: `127.0.0.1:${runtime.port}`
      }
    }, upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
      upstreamRes.on("end", finish);
      upstreamRes.on("close", finish);
    });

    upstream.on("error", error => {
      finish();
      if (!res.headersSent) {
        res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "runtime_proxy_error", message: error.message }));
      } else {
        res.destroy(error);
      }
    });

    req.on("aborted", finish);
    res.on("finish", finish);
    res.on("close", finish);
    req.pipe(upstream);
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const runtime of [this.active, ...this.draining.values()]) {
      if (!runtime) continue;
      runtime.plannedStop = true;
      try { runtime.process.kill("SIGTERM"); } catch {}
    }
  }
}
