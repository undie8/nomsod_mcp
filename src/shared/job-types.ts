export type JobStatus = "running" | "completed" | "failed" | "cancelled";

export interface JobRecord {
  jobId: string;
  command: string;
  cwd?: string;
  shell: string;
  pid?: number;
  status: JobStatus;
  exitCode?: number | null;
  signal?: string | null;
  startedAt: number;
  finishedAt?: number;
  durationMs: number;
  stdoutTail: string;
  stderrTail: string;
  totalStdoutLines: number;
  totalStderrLines: number;
}

export interface StartJobParams {
  command: string;
  cwd?: string;
  shell?: string;
  timeoutMs?: number;
}

export interface StartJobResult {
  jobId: string;
  status: "running";
  pid?: number;
  startedAt: number;
}

export interface GetJobStatusParams {
  jobId: string;
  maxLines?: number;
}

export interface CancelJobParams {
  jobId: string;
}

export interface CancelJobResult {
  jobId: string;
  status: "cancelled";
  message: string;
}
