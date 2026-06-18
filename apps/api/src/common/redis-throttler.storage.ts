import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { ThrottlerStorage } from "@nestjs/throttler";
import Redis from "ioredis";

/**
 * Redis-backed ThrottlerStorage using a fixed-window INCR counter.
 *
 * On the first hit within a window, SET the key with EX (TTL in seconds)
 * and a value of 1. On subsequent hits, INCR atomically. This is simpler
 * than a sliding-window sorted set and avoids race conditions.
 *
 * Shared across all Railway instances so per-IP rate limits are enforced
 * cluster-wide rather than being isolated per-process.
 */
@Injectable()
export class RedisThrottlerStorage implements ThrottlerStorage, OnModuleDestroy {
  private readonly logger = new Logger(RedisThrottlerStorage.name);
  readonly redis: Redis; // `readonly` (not private) so controller can PING it

  constructor(private readonly config: ConfigService) {
    const url = config.get<string>("redis.url") ?? "redis://localhost:6379";
    const password = config.get<string>("redis.password") || undefined;

    this.redis = new Redis(url, {
      password,
      maxRetriesPerRequest: 3,
      connectTimeout: 5_000,
      enableOfflineQueue: true,
    });
    this.redis.on("error", (err) => this.logger.error("Redis throttler error", err));
    this.redis.on("connect", () => this.logger.log("Redis throttler connected"));
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => {});
  }

  async increment(
    key: string,
    ttl: number, // milliseconds
    limit: number,
    blockDuration: number, // milliseconds (may be undefined/0)
    throttlerName: string,
  ): Promise<{
    totalHits: number;
    timeToExpire: number;
    isBlocked: boolean;
    timeToBlockExpire: number;
  }> {
    const ttlSeconds = Math.ceil(ttl / 1000);
    const hitKey = `throttle:hit2:${throttlerName}:${key}`;
    const blockKey = `throttle:blk2:${throttlerName}:${key}`;

    // ── 1. Check existing block ─────────────────────────────────────────────
    const blockPttl = await this.redis.pttl(blockKey).catch(() => -1);
    if (blockPttl > 0) {
      return {
        totalHits: limit + 1,
        timeToExpire: 0,
        isBlocked: true,
        timeToBlockExpire: Math.ceil(blockPttl / 1000),
      };
    }

    // ── 2. Fixed-window INCR counter ────────────────────────────────────────
    let totalHits = 1;
    try {
      // SET NX with expiry creates the key on first hit
      // INCR atomically increments on every hit; GET TTL for timeToExpire
      const lua = `
        local current = redis.call('INCR', KEYS[1])
        if current == 1 then
          redis.call('EXPIRE', KEYS[1], ARGV[1])
        end
        local ttl = redis.call('TTL', KEYS[1])
        return {current, ttl}
      `;
      const result = (await this.redis.eval(lua, 1, hitKey, ttlSeconds)) as [number, number];
      totalHits = result[0];
      const ttlRemaining = result[1] > 0 ? result[1] : ttlSeconds;
      const timeToExpire = ttlRemaining;

      // ── 3. Enforce block when limit exceeded ──────────────────────────────
      let isBlocked = false;
      let timeToBlockExpire = 0;
      if (totalHits > limit) {
        isBlocked = true;
        if (blockDuration) {
          const blockSec = Math.ceil(blockDuration / 1000);
          await this.redis.set(blockKey, "1", "EX", blockSec).catch(() => {});
          timeToBlockExpire = blockSec;
        }
      }

      return { totalHits, timeToExpire, isBlocked, timeToBlockExpire };
    } catch (err) {
      // F9-004: fail CLOSED — treat Redis failure as limit exceeded so auth/reset
      // routes are not trivially bypassable by forcing a Redis outage.
      this.logger.warn("Redis throttler increment failed, failing closed", err);
      return {
        totalHits: limit + 1,
        timeToExpire: ttlSeconds,
        isBlocked: true,
        timeToBlockExpire: ttlSeconds,
      };
    }
  }
}
