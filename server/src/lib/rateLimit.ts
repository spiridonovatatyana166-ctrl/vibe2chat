/**
 * Token bucket: capacity — допустимый всплеск, refillPerSec — устойчивая частота.
 */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity;
    this.last = now();
  }

  take(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((t - this.last) / 1000) * this.refillPerSec);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/**
 * Набор бакетов по ключу (например, по хешу IP) с автоочисткой неактивных.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, { bucket: TokenBucket; seen: number }>();
  private readonly timer: NodeJS.Timeout;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    idleMs = 10 * 60_000,
  ) {
    this.timer = setInterval(() => {
      const cutoff = Date.now() - idleMs;
      for (const [k, v] of this.buckets) if (v.seen < cutoff) this.buckets.delete(k);
    }, Math.min(idleMs, 60_000));
    this.timer.unref();
  }

  take(key: string, cost = 1): boolean {
    let entry = this.buckets.get(key);
    if (!entry) {
      entry = { bucket: new TokenBucket(this.capacity, this.refillPerSec), seen: Date.now() };
      this.buckets.set(key, entry);
    }
    entry.seen = Date.now();
    return entry.bucket.take(cost);
  }

  stop(): void {
    clearInterval(this.timer);
  }
}
