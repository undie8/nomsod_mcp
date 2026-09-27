import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";
import { ReleaseManager, type RuntimeRelease } from "../supervisor/release-manager.js";

interface ManagedWorker extends RuntimeRelease {
  port: number;
  process: ChildProcess;
  inFlight: number;
  draining: boolean;
  plannedStop: boolean;
}

export class AgentWorkerManager {
  private active?: ManagedWorker;
  private readonly draining = new Map<string, ManagedWorker>();
  private operationPromise?: Promise<any>;
  private shuttingDown = false;

  constructor(
    private readonly root: string,
    private readonly ports: [number, number],
    private readonly releaseManager = new ReleaseManager(root, {
      releasesDirName: "agent-releases",
      stateFileName: "agent-runtime-state.json",
      entryRelativePath: path.join("src", "agent", "worker-main.ts")
    }),
    private readonly drainTimeoutMs = 300_000
  ) {}

  private summary(worker: ManagedWorker | undefined) {
    if (!worker) return null;
    return {
      id: worker.id,
      port: worker.port,
      pid: worker.process.pid ?? null,
      createdAt: worker.createdAt,
      inFlight: worker.inFlight,
      draining: worker.draining,
      alive: worker.process.exitCode === null && !worker.process.killed
    };
  }

  status() {
    return {
      guardianPid: process.pid,
      active: this.summary(this.active),
      draining: [...this.draining.values()].map(worker => this.summary(worker)),
      operationInProgress: !!this.operationPromise
    };
  }

  private startWorker(release: RuntimeRelease, port: number): ManagedWorker {
    const workerExecutable =
      process.env.NOMSOD_WORKER_EXECUTABLE?.trim() || process.execPath;

    const processHandle = spawn(
      workerExecutable,
      [release.main],
      {
        cwd: this.root,
        windowsHide: true,
        env: {
          ...process.env,
          NOMSOD_AGENT_WORKER_PORT: String(port)
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"]
      }
    );

    const worker: ManagedWorker = {
      ...release,
      port,
      process: processHandle,
      inFlight: 0,
      draining: false,
      plannedStop: false
    };

    processHandle.stdout?.on("data", chunk =>
      process.stdout.write(`[agent-worker:${release.id}] ${chunk.toString("utf8")}`)
    );
    processHandle.stderr?.on("data", chunk =>
      process.stderr.write(`[agent-worker:${release.id}] ${chunk.toString("utf8")}`)
    );

    processHandle.on("exit", (code, signal) => {
      console.warn(`[agent-guardian] worker ${release.id} exited code=${code} signal=${signal || "-"}`);
      if (worker.plannedStop || this.shuttingDown) return;
      if (this.active?.id !== worker.id) return;

      this.active = undefined;
      setTimeout(() => {
        void this.restartLastGood(release, port);
      }, 1_000);
    });

    return worker;
  }

  private async waitHealthy(worker: ManagedWorker, timeoutMs = 15_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      if (worker.process.exitCode !== null) return false;

      try {
        const response = await fetch(`http://127.0.0.1:${worker.port}/health`, {
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

  private async restartLastGood(release: RuntimeRelease, port: number): Promise<void> {
    if (this.shuttingDown || this.active) return;

    console.warn(`[agent-guardian] restarting last-good worker ${release.id}`);
    const worker = this.startWorker(release, port);

    if (await this.waitHealthy(worker, 15_000)) {
      this.active = worker;
      console.log(`[agent-guardian] worker ${release.id} recovered`);
      return;
    }

    worker.plannedStop = true;
    try { worker.process.kill("SIGKILL"); } catch {}
    console.error("[agent-guardian] worker recovery failed; device connection remains online but actions are unavailable");
  }

  private drainAndStop(worker: ManagedWorker): void {
    worker.draining = true;
    this.draining.set(worker.id, worker);
    const deadline = Date.now() + this.drainTimeoutMs;

    const check = () => {
      if (worker.inFlight <= 0 || Date.now() >= deadline || this.shuttingDown) {
        worker.plannedStop = true;
        try { worker.process.kill("SIGTERM"); } catch {}

        setTimeout(() => {
          if (worker.process.exitCode === null) {
            try { worker.process.kill("SIGKILL"); } catch {}
          }
        }, 5_000).unref();

        this.draining.delete(worker.id);
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
        throw new Error("Initial agent worker typecheck failed:\n" + checked.stderr.slice(-8_000));
      }
      release = await this.releaseManager.createSnapshot();
    }

    let worker = this.startWorker(release, this.ports[0]);

    if (!(await this.waitHealthy(worker, 20_000))) {
      worker.plannedStop = true;
      try { worker.process.kill("SIGKILL"); } catch {}

      const checked = await this.releaseManager.runTypecheck();
      if (!checked.ok) throw new Error("Agent workspace typecheck failed and last-good worker could not start.");

      release = await this.releaseManager.createSnapshot();
      worker = this.startWorker(release, this.ports[0]);

      if (!(await this.waitHealthy(worker, 20_000))) {
        worker.plannedStop = true;
        try { worker.process.kill("SIGKILL"); } catch {}
        throw new Error("No healthy agent worker could be started.");
      }
    }

    this.active = worker;
    await this.releaseManager.markLastGood(release);
    console.log(`[agent-guardian] active worker ${release.id} pid=${worker.process.pid}`);
  }

  async execute(method: string, params?: unknown, timeoutMs = 120_000): Promise<unknown> {
    const worker = this.active;
    if (!worker) throw new Error("Agent action worker is unavailable");

    worker.inFlight += 1;

    try {
      const response = await fetch(`http://127.0.0.1:${worker.port}/execute`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ method, params }),
        signal: AbortSignal.timeout(Math.min(Math.max(timeoutMs, 1_000), 310_000))
      });

      const text = await response.text();
      let body: any;
      try { body = text ? JSON.parse(text) : {}; }
      catch { body = { error: text || `HTTP ${response.status}` }; }

      if (!response.ok) {
        throw new Error(body?.error || `Worker request failed: HTTP ${response.status}`);
      }

      return body.result;
    } finally {
      worker.inFlight = Math.max(0, worker.inFlight - 1);
    }
  }

  async reload(): Promise<any> {
    return this.runExclusive(async () => {
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
      const candidatePort = this.active?.port === this.ports[0] ? this.ports[1] : this.ports[0];
      const candidate = this.startWorker(candidateRelease, candidatePort);

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

      return {
        ok: true,
        switched: true,
        previous: this.summary(previous),
        active: this.summary(candidate),
        connectionPreserved: true
      };
    });
  }

  async rollback(): Promise<any> {
    return this.runExclusive(async () => {
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

      const candidatePort = this.active?.port === this.ports[0] ? this.ports[1] : this.ports[0];
      const candidate = this.startWorker(target, candidatePort);

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

      return {
        ok: true,
        switched: true,
        previous: this.summary(previous),
        active: this.summary(candidate),
        connectionPreserved: true
      };
    });
  }

  private async runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (this.operationPromise) return this.operationPromise as Promise<T>;

    this.operationPromise = operation();
    try {
      return await this.operationPromise;
    } finally {
      this.operationPromise = undefined;
    }
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;

    for (const worker of [this.active, ...this.draining.values()]) {
      if (!worker) continue;
      worker.plannedStop = true;
      try { worker.process.kill("SIGTERM"); } catch {}
    }
  }
}
