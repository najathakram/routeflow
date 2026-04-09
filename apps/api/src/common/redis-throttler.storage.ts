import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";

/**
 * Redis-backed ThrottlerStorage — shared across all Railway instances.
 *
 * Uses a sliding-window sorted-set per (throttlerName, key):
 *   ZADD current-timestamp into the set, ZREMRANGEBYSCORE to evict
 *   expired entries, ZCARD to get the live hit count.
 *
 * Without this, each Node.js process maintains its own in-memory hit
 * counters, making per-IP throttling unreliable in multi-instance deploys.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  private readonly redis: Redis;

  constructor() {
    const url = process.env.REDIS_URL ?? "redis://localhost:6379";
    // Auto-connect (no lazyConnect) so the client is ready before the first request.
    this.redis = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,
      enableOfflineQueue: true,  // queue commands while connecting
    });
    this.redis.on("error", (err) =>
      this.logger.error("Redis throttler client error", err),
    );
    this.redis.on("connect", () =>
      this.logger.log("Redis throttler client connected"),
    );
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {});
  }

  async increment(
    key: string,
    ttl: number,           // milliseconds
    limit: number,
    blockDuration: number, // milliseconds (may be undefined/0)
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const hitKey   = `throttle:hit:${throttlerName}:${key}`;
    const blockKey = `throttle:blk:${throttlerName}:${key}`;

    // ── 1. Check existing block ─────────────────────────────────────────────
    const blockPttl = await this.redis.pttl(blockKey).catch(() => -1);
    if (blockPttl > 0) {
      return {
        totalHits:         limit + 1,
        timeToExpire:      0,
        isBlocked:         true,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    }

    // ── 2. Sliding-window hit counter ───────────────────────────────────────
    const now         = Date.now();
    const windowStart = now - ttl;
    const member      = `${now}:${Math.random().toString(36).slice(2)}`;

    let totalHits = 1;
    try {
      const pipe = this.redis.pipeline();
      pipe.zadd(hitKey, now, member);                      // record this hit
      pipe.zremrangebyscore(hitKey, "-inf", windowStart);  // evict old hits
      pipe.zcard(hitKey);                                  // live count
      pipe.pexpire(hitKey, ttl);                           // auto-expiry

      const results = await pipe.exec();
      if (results && results[2] && results[2][1] != null) {
        totalHits = results[2][1] as number;
      }
    } catch (err) {
      // Redis unavailable — fail open (count as 1, do not block)
      this.logger.warn("Redis throttler increment failed, failing open", err);
    }

    const timeToExpire = Math.ceil(ttl / 1000);

    // ── 3. Enforce block when limit exceeded ────────────────────────────────
    let isBlocked         = false;
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
