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
});
