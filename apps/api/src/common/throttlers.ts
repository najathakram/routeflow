import type { ConfigService } from "@nestjs/config";
import type { ThrottlerOptions } from "@nestjs/throttler";

/**
 * The named throttlers the global ThrottlerGuard (app.module.ts APP_GUARD) runs on every
 * request. Built here, not inline in app.module.ts, so specs drive the exact production set.
 */
export function buildThrottlers(_config: ConfigService): ThrottlerOptions[] {
  // Global throttle: 100 req / 60 s per IP (per route handler — the guard's key is
  // class + handler + throttler name + IP).
  return [{ ttl: 60_000, limit: 100 }];
}
