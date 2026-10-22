import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionLiveness, ReconnectScheduler } from "../src/agent/connection-recovery.js";

afterEach(() => vi.useRealTimers());

describe("reconnect scheduling", () => {
  it("coalesces repeated discovery and close requests without shortening backoff", () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const scheduler = new ReconnectScheduler(connect, () => 1000);
    expect(scheduler.schedule("peer")).toBe(1000);
    vi.advanceTimersByTime(800);
    expect(scheduler.schedule("peer", 0)).toBeUndefined();
    expect(scheduler.hasPending("peer")).toBe(true);
    vi.advanceTimersByTime(200);
    expect(connect).toHaveBeenCalledExactlyOnceWith("peer");
    expect(scheduler.hasPending("peer")).toBe(false);
    scheduler.clear();
  });

  it("retains failure backoff until authenticated readiness resets it", () => {
    vi.useFakeTimers();
    const scheduler = new ReconnectScheduler(vi.fn(), attempt => 100 * 2 ** attempt);
    expect(scheduler.schedule("peer")).toBe(100);
    vi.advanceTimersByTime(100);
    expect(scheduler.schedule("peer")).toBe(200);
    scheduler.reset("peer");
    expect(scheduler.schedule("peer")).toBe(100);
    scheduler.clear();
  });

  it("cancels removed peers and all timers during shutdown", () => {
    vi.useFakeTimers();
    const connect = vi.fn();
    const scheduler = new ReconnectScheduler(connect, () => 1000);
    scheduler.schedule("removed");
    scheduler.reset("removed");
    scheduler.schedule("remaining");
    scheduler.clear();
    vi.advanceTimersByTime(5000);
    expect(connect).not.toHaveBeenCalled();
  });
});

describe("connection liveness after a pause", () => {
  it("allows a bounded recovery window even if the stale timer runs before wake detection", () => {
    const connection = new ConnectionLiveness(45_000, 0);
    expect(connection.isStale(7500)).toBe(false);
    expect(connection.isStale(120_000)).toBe(false);
    expect(connection.isStale(140_000)).toBe(false);
    expect(connection.isStale(150_001)).toBe(true);
  });

  it("keeps a recovered connection alive after receiving a pong or heartbeat", () => {
    const connection = new ConnectionLiveness(45_000, 0);
    connection.resume(120_000);
    connection.received(125_000);
    expect(connection.isStale(150_001)).toBe(false);
  });

  it("still rejects a dead connection without a pause or after recovery grace expires", () => {
    const connection = new ConnectionLiveness(45_000, 0);
    for (let now = 7500; now <= 45_000; now += 7500) expect(connection.isStale(now)).toBe(false);
    expect(connection.isStale(52_500)).toBe(true);
    connection.resume(60_000);
    expect(connection.isStale(80_000)).toBe(false);
    expect(connection.isStale(90_001)).toBe(true);
  });
});
