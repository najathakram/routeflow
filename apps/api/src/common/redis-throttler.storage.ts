import { Injectable, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";

/**
 * Redis-backed implementation of ThrottlerStorage.
 *
 * Uses a sliding-window counter per (key, throttlerName):
 *   - ZADD the current timestamp into a sorted set
 *   - ZREMRANGEBYSCORE to expire entries older than the TTL window
 *   - ZCARD to get the current hit count in the window
 *
 * This ensures rate-limit counters are shared across all Railway instances
 * (rather than being isolated per-process in RAM).
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly redis: Redis;

  constructor() {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,
      lazyConnect: true,
    });
    this.redis.connect().catch(() => {
      // Non-fatal: throttler will fall back gracefully if Redis is unavailable
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {});
  }

  async increment(
    key: string,
    ttl: number,          // milliseconds
    limit: number,
    blockDuration: number, // milliseconds (may be undefined)
    throttlerName: string,
  ): Promise<{ totalHits: number; timeToExpire: number; isBlocked: boolean; timeToBlockExpire: number }> {
    const hitKey   = `throttle:hit:${throttlerName}:${key}`;
    const blockKey = `throttle:blk:${throttlerName}:${key}`;

    // ── 1. Check existing block ───────────────────────────────────────────────
    const blockPttl = await this.redis.pttl(blockKey).catch(() => -1);
    if (blockPttl > 0) {
      return {
        totalHits:        limit + 1,
        timeToExpire:     0,
        isBlocked:        true,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    }

    // ── 2. Sliding-window counter ─────────────────────────────────────────────
    const now         = Date.now();
    const windowStart = now - ttl;
    const member      = `${now}:${Math.random()}`;   // unique member

    const pipe = this.redis.pipeline();
    pipe.zadd(hitKey, now, member);                   // record this hit
    pipe.zremrangebyscore(hitKey, "-inf", windowStart); // evict expired hits
    pipe.zcard(hitKey);                               // count hits in window
    pipe.pexpire(hitKey, ttl);                        // auto-clean the set

    const results  = await pipe.exec().catch(() => null);
    const totalHits: number =
      results && results[2] && results[2][1] != null
        ? (results[2][1] as number)
        : 1;

    const timeToExpire = Math.ceil(ttl / 1000);

    // ── 3. Apply block if limit exceeded ────────────────────────────────────────
    let isBlocked        = false;
    let timeToBlockExpire = 0;
    if (totalHits > limit) {
      isBlocked = true;
      if (blockDuration) {
        await this.redis
          .set(blockKey, "1", "PX", blockDuration)
          .catch(() => {});
        timeToBlockExpire = Math.ceil(blockDuration / 1000);
      }
    }

    return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
  }
}
