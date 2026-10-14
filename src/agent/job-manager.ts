import { spawn, ChildProcess, execFile } from "node:child_process";
import { promisify } from "node:util";
import crypto from "node:crypto";
import {
  JobStatus,
  JobRecord,
  StartJobParams,
  StartJobResult,
  CancelJobResult
} from "../shared/job-types.js";

const execFileAsync = promisify(execFile);

function encodePowerShellCommand(command: string): string {
  const prelude = [
    "$ProgressPreference = \"SilentlyContinue\";",
    "$__nomsodUtf8 = New-Object System.Text.UTF8Encoding($false);",
    "[Console]::InputEncoding = $__nomsodUtf8;",
    "[Console]::OutputEncoding = $__nomsodUtf8;",
    "$OutputEncoding = $__nomsodUtf8;"
  ].join(" ");
  return Buffer.from(`${prelude} ${command}`, "utf16le").toString("base64");
}

export interface ActionRecord {
  action: string;
  detail: string;
  durationMs: number;
  timestamp: number;
  status: "completed" | "failed";
}

interface InternalJob extends JobRecord {
  process?: ChildProcess;
  stdoutLines: string[];
  stderrLines: string[];
  fullStdoutChunks: Buffer[];
  fullStderrChunks: Buffer[];
  timeoutTimer?: NodeJS.Timeout;
}

export class JobManager {
  private jobs = new Map<string, InternalJob>();
  private maxBufferLines = 200;
  private maxBufferBytes = 64 * 1024; // 64KB
  private ttlMs = 60 * 60 * 1000; // 1 hour
  private maxCompletedJobs = 200;

  constructor() {
    // Periodically clean up old jobs
    setInterval(() => this.pruneJobs(), 5 * 60 * 1000).unref();
  }

  public async start(params: StartJobParams): Promise<StartJobResult> {
    const jobId = `job_${crypto.randomUUID()}`;
    const startedAt = Date.now();
    const command = params.command;
    const cwd = params.cwd;
    const shellParam = params.shell;

    let shell: string;
    let spawnArgs: string[];
    const isWin = process.platform === "win32";

    if (shellParam) {
      shell = shellParam;
      spawnArgs = [command]; // or custom shell invocation
    } else if (isWin) {
      shell = "powershell.exe";
      const encoded = encodePowerShellCommand(command);
      spawnArgs = ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded];
    } else {
      shell = "/bin/bash";
      spawnArgs = ["-c", command];
    }

    const child = spawn(shell, spawnArgs, {
      cwd,
      detached: !isWin,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    const internalJob: InternalJob = {
      jobId,
      command,
      cwd,
      shell,
      pid: child.pid,
      status: "running",
      exitCode: undefined,
      signal: undefined,
      startedAt,
      durationMs: 0,
      stdoutTail: "",
      stderrTail: "",
      totalStdoutLines: 0,
      totalStderrLines: 0,
      process: child,
      stdoutLines: [],
      stderrLines: [],
      fullStdoutChunks: [],
      fullStderrChunks: []
    };

    if (params.timeoutMs && params.timeoutMs > 0) {
      internalJob.timeoutTimer = setTimeout(async () => {
        try {
          await this.cancel(jobId);
          const j = this.jobs.get(jobId);
          if (j) {
            j.status = "failed";
            j.finishedAt = Date.now();
            j.durationMs = j.finishedAt - j.startedAt;
          }
        } catch {}
      }, params.timeoutMs);
      internalJob.timeoutTimer.unref();
    }

    child.stdout?.on("data", (chunk: Buffer) => {
      internalJob.fullStdoutChunks.push(chunk);
      this.appendOutput(internalJob, chunk, false);
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      internalJob.fullStderrChunks.push(chunk);
      this.appendOutput(internalJob, chunk, true);
    });

    child.on("error", (err) => {
      if (internalJob.timeoutTimer) clearTimeout(internalJob.timeoutTimer);
      internalJob.status = "failed";
      internalJob.finishedAt = Date.now();
      internalJob.durationMs = internalJob.finishedAt - internalJob.startedAt;
      internalJob.stderrLines.push(`[job error] ${err.message}`);
      internalJob.totalStderrLines++;
      internalJob.stderrTail = internalJob.stderrLines.join("\n");
    });

    child.on("close", (code, signal) => {
      if (internalJob.timeoutTimer) clearTimeout(internalJob.timeoutTimer);
      internalJob.finishedAt = Date.now();
      internalJob.durationMs = internalJob.finishedAt - internalJob.startedAt;
      internalJob.exitCode = code;
      internalJob.signal = signal;
      if (internalJob.status === "running") {
        internalJob.status = code === 0 ? "completed" : "failed";
      }
      internalJob.process = undefined;
      this.enforceCompletedLimit();
    });

    this.jobs.set(jobId, internalJob);

    return {
      jobId,
      status: "running",
      pid: child.pid,
      startedAt
    };
  }

  public async executeSync(params: StartJobParams): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    shell: string;
    encoding: string;
  }> {
    const started = await this.start(params);
    const job = this.jobs.get(started.jobId);
    if (!job || !job.process) {
      throw new Error(`Failed to start command: ${params.command}`);
    }

    const child = job.process;
    return new Promise((resolve) => {
      child.on("close", (code) => {
        const fullStdout = Buffer.concat(job.fullStdoutChunks).toString("utf8");
        const fullStderr = Buffer.concat(job.fullStderrChunks).toString("utf8");
        job.fullStdoutChunks = [];
        job.fullStderrChunks = [];
        resolve({
          exitCode: typeof code === "number" ? code : job.status === "completed" ? 0 : 1,
          stdout: fullStdout,
          stderr: fullStderr,
          shell: job.shell,
          encoding: "utf-8"
        });
      });

      child.on("error", (err) => {
        const fullStdout = Buffer.concat(job.fullStdoutChunks).toString("utf8");
        const fullStderr = Buffer.concat(job.fullStderrChunks).toString("utf8");
        job.fullStdoutChunks = [];
        job.fullStderrChunks = [];
        resolve({
          exitCode: 1,
          stdout: fullStdout,
          stderr: fullStderr || err.message,
          shell: job.shell,
          encoding: "utf-8"
        });
      });
    });
  }

  private lastAction?: ActionRecord;

  public recordAction(action: string, detail: string, durationMs: number, status: "completed" | "failed" = "completed"): void {
    this.lastAction = {
      action,
      detail,
      durationMs,
      timestamp: Date.now(),
      status
    };
  }

  public getLastAction(): ActionRecord | undefined {
    return this.lastAction;
  }

  public getStatus(jobId: string, maxLines?: number): JobRecord | undefined {
    const job = this.jobs.get(jobId);
    if (!job) return undefined;

    const limit = maxLines && maxLines > 0 ? maxLines : this.maxBufferLines;

    const stdoutLines = job.stdoutLines.slice(-limit);
    const stderrLines = job.stderrLines.slice(-limit);

    const record: JobRecord = {
      jobId: job.jobId,
      command: job.command,
      cwd: job.cwd,
      shell: job.shell,
      pid: job.pid,
      status: job.status,
      exitCode: job.exitCode,
      signal: job.signal,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      durationMs: job.finishedAt ? job.finishedAt - job.startedAt : Date.now() - job.startedAt,
      stdoutTail: stdoutLines.join("\n"),
      stderrTail: stderrLines.join("\n"),
      totalStdoutLines: job.totalStdoutLines,
      totalStderrLines: job.totalStderrLines
    };

    return record;
  }

  public async cancel(jobId: string): Promise<CancelJobResult> {
    const job = this.jobs.get(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }

    if (job.timeoutTimer) clearTimeout(job.timeoutTimer);

    if (job.status !== "running" || !job.pid) {
      return {
        jobId,
        status: "cancelled",
        message: `Job ${jobId} was already ${job.status}`
      };
    }

    job.status = "cancelled";
    try {
      if (process.platform === "win32") {
        await execFileAsync("taskkill", ["/pid", String(job.pid), "/t", "/f"]);
      } else {
        try {
          process.kill(-job.pid, "SIGTERM");
        } catch {
          process.kill(job.pid, "SIGTERM");
        }
      }
    } catch (err: any) {
      // Ignore if process already exited
    }

    job.finishedAt = Date.now();
    job.durationMs = job.finishedAt - job.startedAt;
    job.process = undefined;
    this.enforceCompletedLimit();

    return {
      jobId,
      status: "cancelled",
      message: `Job ${jobId} cancelled successfully`
    };
  }

  public listJobs(): JobRecord[] {
    const records: JobRecord[] = [];
    for (const job of this.jobs.values()) {
      records.push(this.getStatus(job.jobId) as JobRecord);
    }
    return records;
  }

  private appendOutput(job: InternalJob, chunk: Buffer, isStderr: boolean) {
    const text = chunk.toString("utf8");
    const lines = text.split(/\r?\n/);
    // Handle split lines across chunks if needed, but simple split is robust for ring buffer tail
    const targetLines = isStderr ? job.stderrLines : job.stdoutLines;

    for (const line of lines) {
      targetLines.push(line);
      if (isStderr) {
        job.totalStderrLines++;
      } else {
        job.totalStdoutLines++;
      }
    }

    // Trim ring buffer to maxBufferLines and maxBufferBytes
    while (targetLines.length > this.maxBufferLines) {
      targetLines.shift();
    }

    const tailStr = targetLines.join("\n");
    if (Buffer.byteLength(tailStr, "utf8") > this.maxBufferBytes) {
      // Trim from front until within byte limit
      while (targetLines.length > 0 && Buffer.byteLength(targetLines.join("\n"), "utf8") > this.maxBufferBytes) {
        targetLines.shift();
      }
    }

    if (isStderr) {
      job.stderrTail = targetLines.join("\n");
    } else {
      job.stdoutTail = targetLines.join("\n");
    }
  }

  private pruneJobs() {
    const now = Date.now();
    for (const [jobId, job] of this.jobs.entries()) {
      if (job.status !== "running" && job.finishedAt && now - job.finishedAt > this.ttlMs) {
        this.jobs.delete(jobId);
      }
    }
  }

  private enforceCompletedLimit() {
    const completedOrEnded: [string, InternalJob][] = [];
    for (const entry of this.jobs.entries()) {
      if (entry[1].status !== "running") {
        completedOrEnded.push(entry);
      }
    }

    if (completedOrEnded.length > this.maxCompletedJobs) {
      // Sort by finishedAt ascending (oldest first)
      completedOrEnded.sort((a, b) => (a[1].finishedAt || 0) - (b[1].finishedAt || 0));
      const excess = completedOrEnded.length - this.maxCompletedJobs;
      for (let i = 0; i < excess; i++) {
        this.jobs.delete(completedOrEnded[i][0]);
      }
    }
  }
}
