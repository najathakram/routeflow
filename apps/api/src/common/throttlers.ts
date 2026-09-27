import { SetMetadata } from "@nestjs/common";
import type { ExecutionContext } from "@nestjs/common";
import type { ConfigService } from "@nestjs/config";
import type { ThrottlerOptions } from "@nestjs/throttler";

/** The throttle window both named throttlers count in. */
const WINDOW_MS = 60_000;

/** Marker for the controllers the named "uploads" throttler applies to (#2091). */
export const UPLOADS_THROTTLED = "rf:uploadsThrottled";

/**
 * #2091: put a controller (or handler) under the "uploads" throttler. Pair it with
 * `@SkipThrottle({ default: true })` so the ordinary 100 / 60 s limit does not also apply.
 */
export const UploadsThrottled = () => SetMetadata(UPLOADS_THROTTLED, true);

function isUploadsThrottled(ctx: ExecutionContext): boolean {
  return (
    Reflect.getMetadata(UPLOADS_THROTTLED, ctx.getHandler()) === true ||
    Reflect.getMetadata(UPLOADS_THROTTLED, ctx.getClass()) === true
  );
}

/**
 * The named throttlers the global ThrottlerGuard (app.module.ts APP_GUARD) runs on every
 * request. Built here, not inline in app.module.ts, so specs drive the exact production set.
 *
 * - "default": 100 req / 60 s per IP (per route handler — the guard's key is class + handler +
 *   throttler name + IP). Every route, except those that `@SkipThrottle({ default: true })`.
 * - "uploads" (#2091): signed product-image GETs. One catalog page — or several staff behind one
 *   shop IP — loads far more than 100 images a minute, so images past the 100th used to 429 and
 *   render broken. They get their own per-IP ceiling, `throttle.uploadsLimit` (default 1200 /
 *   60 s), and it applies ONLY to `@UploadsThrottled()` routes: throttler v6 checks every named
 *   throttler on every route, so without the `skipIf` an ordinary route would also count against
 *   the image ceiling.
 */
export function buildThrottlers(config: ConfigService): ThrottlerOptions[] {
  const uploadsLimit = Number(config.get("throttle.uploadsLimit")) || 1200;
  return [
    { name: "default", ttl: WINDOW_MS, limit: 100 },
    {
      name: "uploads",
      ttl: WINDOW_MS,
      limit: uploadsLimit,
      skipIf: (ctx: ExecutionContext) => !isUploadsThrottled(ctx),
    },
  ];
}
