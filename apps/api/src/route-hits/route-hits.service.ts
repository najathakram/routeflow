import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import Redis from "ioredis";
import { RouteHitBuffer } from "./route-hit-buffer";
import {
  ROUTE_HITS_DROPPED_FIELD,
  ROUTE_HITS_FLUSH_MS,
  ROUTE_HITS_TTL_SECONDS,
  routeHitsDayKey,
  routeHitsEnabled,
} from "./route-hits.constants";

/** The slice of ioredis the service uses, so a spec can hand in a fake. */
export interface RouteHitsRedis {
  pipeline(): {
    hincrby(key: string, field: string, n: number): unknown;
    expire(key: string, seconds: number): unknown;
    exec(): Promise<unknown>;
  };
  quit?(): Promise<unknown>;
  disconnect?(): void;
  on?(event: string, fn: (...a: unknown[]) => void): unknown;
}

/**
 * W3: counts how often each API route template is called, to find routes nobody calls (dead-weight W3).
 *
 *  - `record()` is synchronous and touches ONLY an in-memory bounded Map: nothing on the request path
 *    awaits, and no Redis call is made there.
 *  - A timer flushes the Map every 10 s with ONE Redis pipeline (HINCRBY per route + EXPIRE). Every replica
 *    flushes independently; HINCRBY is additive, so the daily totals add up across replicas.
 *  - Counts are best effort: Redis errors are swallowed (a request is never affected) and whatever is in the
 *    buffer at a crash or a shutdown is lost (at most ~10 s per replica). If Redis is not persistent a Redis
 *    restart resets the day's bucket; the report treats a missing day as UNOBSERVED, never as zero.
 *  - The day bucket is the UTC day at FLUSH time, so up to 10 s of counts around midnight land in the next day.
 */
@Injectable()
export class RouteHitsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RouteHitsService.name);
  private readonly buffer = new RouteHitBuffer();
  private redis: RouteHitsRedis | null = null;
  private timer: NodeJS.Timeout | null = null;
  private warned = false;
  /** Public so a spec can switch it (it is ON under Jest only when a spec asks). */
  enabled: boolean = routeHitsEnabled();

  constructor(private readonly config: ConfigService) {}

  /** A spec hands in a fake Redis here; production builds its own client in `onModuleInit`. */
  attachRedis(redis: RouteHitsRedis): void {
    this.redis = redis;
  }

  onModuleInit(): void {
    if (!this.enabled) return;
    if (!this.redis) {
      const url = this.config.get<string>("redis.url") ?? "redis://localhost:6379";
      const password = this.config.get<string>("redis.password") || undefined;
      const client = new Redis(url, {
        password,
        lazyConnect: false,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false, // a down Redis fails the flush fast instead of queueing it
        connectTimeout: 5_000,
        commandTimeout: 5_000, // a hung Redis fails the flush instead of stalling it
      });
      client.on("error", () => this.warnOnce());
      this.redis = client;
    }
    this.timer = setInterval(() => void this.flush(), ROUTE_HITS_FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(); // best effort; a failure here only loses the last <=10 s
    const redis = this.redis;
    // quit() flushes politely; if it fails (Redis down), drop the socket so shutdown never hangs.
    await redis?.quit?.().catch?.(() => redis?.disconnect?.());
  }

  /** Counts one call to `key` (a route template). Synchronous, in memory only. */
  record(key: string): void {
    if (this.enabled) this.buffer.record(key);
  }

  /** Writes the buffered counts to Redis. Never throws. */
  async flush(now: Date = new Date()): Promise<void> {
    const { counts, dropped } = this.buffer.drain();
    if (!this.redis || (counts.size === 0 && dropped === 0)) return;
    try {
      const day = routeHitsDayKey(now);
      const pipe = this.redis.pipeline();
      for (const [route, n] of counts) pipe.hincrby(day, route, n);
      if (dropped > 0) pipe.hincrby(day, ROUTE_HITS_DROPPED_FIELD, dropped);
      pipe.expire(day, ROUTE_HITS_TTL_SECONDS);
      await pipe.exec();
    } catch {
      this.warnOnce();
    }
  }

  private warnOnce(): void {
    if (this.warned) return;
    this.warned = true;
    this.logger.warn(
      "route hit counter: Redis unavailable; counts are best effort and are skipped",
    );
  }
}
