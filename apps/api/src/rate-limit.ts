export class DemoRateLimiter {
  private readonly requests = new Map<string, number[]>();

  constructor(private readonly max = 30, private readonly windowMs = 60_000) {}

  check(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.requests.get(key) ?? []).filter((timestamp) => timestamp > cutoff);
    if (recent.length >= this.max) {
      this.requests.set(key, recent);
      return false;
    }
    recent.push(now);
    this.requests.set(key, recent);
    return true;
  }
}
