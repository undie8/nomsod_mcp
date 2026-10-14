import { describe, it, expect } from "vitest";
import { JobManager } from "../src/agent/job-manager.js";

describe("JobManager", () => {
  it("should start, track, and complete a simple command", async () => {
    const manager = new JobManager();
    const isWin = process.platform === "win32";
    const command = isWin ? "echo hello_nomsod" : "echo 'hello_nomsod'";

    const result = await manager.start({ command });
    expect(result.jobId).toBeDefined();
    expect(result.status).toBe("running");

    // Wait for process to finish
    let status = manager.getStatus(result.jobId);
    for (let i = 0; i < 40; i++) {
      if (status?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 100));
      status = manager.getStatus(result.jobId);
    }

    expect(status).toBeDefined();
    expect(status?.status).toBe("completed");
    expect(status?.stdoutTail).toContain("hello_nomsod");
    expect(status?.totalStdoutLines).toBeGreaterThan(0);
  });

  it("should list jobs", async () => {
    const manager = new JobManager();
    const isWin = process.platform === "win32";
    const command = isWin ? "echo list_test" : "echo 'list_test'";

    await manager.start({ command });
    await new Promise((resolve) => setTimeout(resolve, 500));

    const jobs = manager.listJobs();
    expect(jobs.length).toBe(1);
    expect(jobs[0].command).toBe(command);
  });

  it("should cancel a running job", async () => {
    const manager = new JobManager();
    const isWin = process.platform === "win32";
    const command = isWin ? "Start-Sleep -Seconds 10" : "sleep 10";

    const result = await manager.start({ command });
    expect(result.status).toBe("running");

    const cancelResult = await manager.cancel(result.jobId);
    expect(cancelResult.status).toBe("cancelled");

    const status = manager.getStatus(result.jobId);
    expect(status?.status).toBe("cancelled");
  });

  it("should execute synchronous command and return output", async () => {
    const manager = new JobManager();
    const isWin = process.platform === "win32";
    const command = isWin ? "echo sync_test_output" : "echo 'sync_test_output'";

    const result = await manager.executeSync({ command });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("sync_test_output");
    expect(result.encoding).toBe("utf-8");

    // Should also be in job list as completed
    const jobs = manager.listJobs();
    expect(jobs.length).toBeGreaterThan(0);
    expect(jobs[0].status).toBe("completed");
  });

  it("should record and retrieve lightweight action status", () => {
    const manager = new JobManager();
    expect(manager.getLastAction()).toBeUndefined();

    manager.recordAction("fs.patch", "SubjectCriteriaEntryNotice.tsx", 25, "completed");
    const last = manager.getLastAction();
    expect(last).toBeDefined();
    expect(last?.action).toBe("fs.patch");
    expect(last?.detail).toBe("SubjectCriteriaEntryNotice.tsx");
    expect(last?.durationMs).toBe(25);
    expect(last?.status).toBe("completed");
  });
});
