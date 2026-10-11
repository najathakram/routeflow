import { createHash } from "node:crypto";
import type { ThrottlerStorage } from "@nestjs/throttler";

/** DI token for the limiter storage the resend path counts in (the repo's `RedisThrottlerStorage`). */
export const RESEND_LIMITER = Symbol("TENANTS_RESEND_VERIFICATION_LIMITER");

/** One resend per address per 10 minutes. */
export const RESEND_COOLDOWN = { ttl: 10 * 60_000, limit: 1 } as const;

/** At most 5 resends per address per 24 hours. */
export const RESEND_DAILY_CAP = { ttl: 24 * 60 * 60_000, limit: 5 } as const;

const COOLDOWN_NAME = "resend-verify-cooldown";
const DAILY_NAME = "resend-verify-daily";

/**
 * The limiter key for an address: sha256 of the lowercased, trimmed address, hex. Case and
 * whitespace variants of one address share a counter, and the raw address is never part of a key.
 */
export function resendAddressKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

type Limiter = Pick<ThrottlerStorage, "increment">;

async function hit(
  limiter: Limiter,
  name: string,
  key: string,
  window: { ttl: number; limit: number },
): Promise<boolean> {
  try {
    const r = await limiter.increment(`${name}:${key}`, window.ttl, window.limit, 0, name);
    return !r.isBlocked && r.totalHits <= window.limit;
  } catch {
    // An unreachable limiter refuses: sending a mail is never the fallback.
    return false;
  }
}

/**
 * Counts one resend attempt for the address and says whether it may proceed: the cooldown is
 * checked first, then the daily cap. It runs for every address (known or not), before any account
 * lookup, so neither the outcome nor its timing depends on whether the address exists. A limiter
 * failure refuses (fail closed).
 *
 * The daily cap is per address, so a third party can use up one address's resends for a day; the
 * fallback for that owner is the back office.
 */
export async function mayResendTo(limiter: Limiter | undefined, email: string): Promise<boolean> {
  if (!limiter) return false;
  const key = resendAddressKey(email);
  if (!(await hit(limiter, COOLDOWN_NAME, key, RESEND_COOLDOWN))) return false;
  return hit(limiter, DAILY_NAME, key, RESEND_DAILY_CAP);
}
