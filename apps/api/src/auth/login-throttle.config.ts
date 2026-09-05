// RF-160 / pB10: env-configurable login throttle. Production defaults are
// unchanged (10 requests / 5 min per IP) — the env knobs exist so a local
// Docker stack (Playwright, retries, other local sessions all sharing
// 127.0.0.1) can raise the limit without touching prod behaviour. An
// invalid/missing value always falls back to the default; this never throws.
import { Logger } from "@nestjs/common";

const DEFAULT_LIMIT = 10;
const DEFAULT_TTL_MS = 300_000;

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  // Whole positive integers only. Number.parseInt() stops at the first non-digit, so
  // "300_000" would silently become 300 (a 0.3s window ≈ unlimited brute force) and
  // "1_000" would become 1 (every login 429s after one attempt). Reject the string
  // outright instead of accepting a partial parse.
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number.parseInt(trimmed, 10);
  return parsed > 0 ? parsed : fallback;
}

export function loginThrottleConfig(env: NodeJS.ProcessEnv = process.env): {
  limit: number;
  ttl: number;
} {
  return {
    limit: parsePositiveInt(env.AUTH_LOGIN_THROTTLE_LIMIT, DEFAULT_LIMIT),
    ttl: parsePositiveInt(env.AUTH_LOGIN_THROTTLE_TTL_MS, DEFAULT_TTL_MS),
  };
}

let cached: { limit: number; ttl: number } | undefined;

/**
 * Lazily resolve — and then memoize — the login throttle. The `@Throttle` decorator
 * on `POST /auth/login` calls this per request, so the read happens after
 * `ConfigModule.forRoot()` has copied `apps/api/.env` into `process.env`. Reading at
 * module-init time instead would run while the import graph is still being evaluated
 * (`app.module.ts` imports `AuthModule` before its own `@Module({...})` argument is
 * built), which silently ignores any value set in `apps/api/.env`.
 */
export function resolveLoginThrottle(): { limit: number; ttl: number } {
  if (!cached) {
    cached = loginThrottleConfig();
    logResolvedThrottle(cached);
  }
  return cached;
}

/**
 * Log the effective throttle exactly once (from the memoized resolve above), so a rejected
 * or overridden value is visible in the boot log instead of silently changing brute-force
 * protection. `loginThrottleConfig()` itself stays pure and silent.
 */
function logResolvedThrottle(cfg: { limit: number; ttl: number }): void {
  const logger = new Logger("LoginThrottle");
  const provided: Array<[string, string | undefined, number, number]> = [
    ["AUTH_LOGIN_THROTTLE_LIMIT", process.env.AUTH_LOGIN_THROTTLE_LIMIT, cfg.limit, DEFAULT_LIMIT],
    ["AUTH_LOGIN_THROTTLE_TTL_MS", process.env.AUTH_LOGIN_THROTTLE_TTL_MS, cfg.ttl, DEFAULT_TTL_MS],
  ];
  let anySet = false;
  for (const [name, raw, effective, fallback] of provided) {
    if (raw === undefined) continue;
    anySet = true;
    if (String(effective) !== raw.trim()) {
      logger.warn(`${name}="${raw}" is not a positive integer — using default ${fallback}`);
    }
  }
  if (anySet) {
    logger.log(`login throttle override in effect: limit=${cfg.limit} ttl=${cfg.ttl}ms`);
  }
}

/** Test-only: drop the memoized value so a spec can vary the env. */
export function __resetLoginThrottleCache(): void {
  cached = undefined;
}
