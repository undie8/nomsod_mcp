function backoffMs(attempt: number): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5));
  return base + Math.floor(Math.random() * Math.max(250, base * 0.25));
}

export class ReconnectScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly attempts = new Map<string, number>();

  constructor(
    private readonly connect: (url: string) => void,
    private readonly delayForAttempt = backoffMs
  ) {}

  hasPending(url: string): boolean {
    return this.timers.has(url);
  }

  schedule(url: string, delayOverride?: number): number | undefined {
    if (this.timers.has(url)) return undefined;
    const attempt = this.attempts.get(url) || 0;
    const delay = delayOverride ?? this.delayForAttempt(attempt);
    this.attempts.set(url, attempt + 1);
    const timer = setTimeout(() => {
      this.timers.delete(url);
      this.connect(url);
    }, delay);
    timer.unref();
    this.timers.set(url, timer);
    return delay;
  }

  reset(url: string): void {
    const timer = this.timers.get(url);
    if (timer) clearTimeout(timer);
    this.timers.delete(url);
    this.attempts.delete(url);
  }

  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.attempts.clear();
  }
}

export class ConnectionLiveness {
  private lastInbound: number;
  private lastCheck: number;
  private graceUntil = 0;

  constructor(private readonly staleMs: number, now = Date.now()) {
    this.lastInbound = now;
    this.lastCheck = now;
  }

  received(now = Date.now()): void {
    this.lastInbound = now;
  }

  resume(now = Date.now()): void {
    this.lastCheck = now;
    this.graceUntil = now + Math.min(this.staleMs, 30_000);
  }

  isStale(now = Date.now()): boolean {
    // Timer order after resume is unspecified; give inbound traffic time to recover.
    if (now - this.lastCheck > this.staleMs) this.resume(now);
    this.lastCheck = now;
    return now > this.graceUntil && now - this.lastInbound > this.staleMs;
  }
}
