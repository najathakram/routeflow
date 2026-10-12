import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { AUTO_LOCKS_PAUSED_KEY, type AutoLockSwitch } from "./auto-lock-gate";

export interface AutoLockSwitchState {
  paused: boolean;
  /** When the stored value was last written; null while the key is missing (never set = paused by default). */
  since: Date | null;
  reason: string | null;
  by: string | null;
}

/**
 * The stored value is JSON `{ "paused": boolean, "reason", "by", "at" }`; a bare `false` / `"false"` is read
 * the same way. PAUSED unless the value says, explicitly, that it is not: a missing key, an empty or
 * unparseable value, `true`, `"paused"`, `0`, anything else = PAUSED. The rollout starts paused with no
 * seed step; unpausing is an explicit act.
 */
export function parseAutoLockStored(raw: string | null | undefined): {
  paused: boolean;
  reason: string | null;
  by: string | null;
} {
  const paused = { paused: true, reason: null, by: null };
  if (raw == null) return paused;
  const text = raw.trim();
  if (text.toLowerCase() === "false") return { paused: false, reason: null, by: null };
  try {
    const v: unknown = JSON.parse(text);
    if (v === false) return { paused: false, reason: null, by: null };
    if (v && typeof v === "object" && (v as { paused?: unknown }).paused === false) {
      const o = v as { reason?: unknown; by?: unknown };
      return {
        paused: false,
        reason: typeof o.reason === "string" ? o.reason : null,
        by: typeof o.by === "string" ? o.by : null,
      };
    }
    if (v && typeof v === "object" && (v as { paused?: unknown }).paused === true) {
      const o = v as { reason?: unknown; by?: unknown };
      return {
        paused: true,
        reason: typeof o.reason === "string" ? o.reason : null,
        by: typeof o.by === "string" ? o.by : null,
      };
    }
  } catch {
    /* not JSON: paused */
  }
  return paused;
}

/**
 * SA-775: the platform-wide "automatic locks paused" switch, stored in `PlatformConfig` (same raw-SQL pattern as
 * `EntitlementsModeService`). A standalone billing service rather than a `PlatformConfigService` method: the
 * billing crons and the Stripe webhook need it, and `PlatformAdminModule` already imports `BillingModule`, so a
 * back edge would be a module cycle (the precedent is `entitlements-mode.service.ts`).
 *
 * `isPaused()` is read on every automatic lock decision. Only a PAUSED answer is cached (at most 30 s per
 * process): an UNPAUSED answer is never served from cache, so a re-pause takes effect on every replica on its
 * very next lock decision (one primary-key read per decision; the crons are hourly and the webhook rare).
 * After an unpause another replica may keep serving its cached `paused` for up to the TTL - the safe
 * direction. `setPaused` refreshes the local cache at once. A read error is treated as PAUSED and is not
 * cached: a database that cannot answer must never be the reason a tenant is locked.
 */
@Injectable()
export class AutoLockSwitchService implements AutoLockSwitch {
  private readonly logger = new Logger(AutoLockSwitchService.name);
  static readonly CACHE_TTL_MS = 30_000;
  private cached: { value: AutoLockSwitchState; expiresAt: number } | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async isPaused(): Promise<boolean> {
    return (await this.getState()).paused;
  }

  /** The switch with its provenance (cached like `isPaused`). */
  async getState(): Promise<AutoLockSwitchState> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    try {
      const rows = await this.prisma.$queryRaw<{ value: string; updatedAt: Date }[]>`
        SELECT value, "updatedAt" FROM "PlatformConfig" WHERE key = ${AUTO_LOCKS_PAUSED_KEY} LIMIT 1
      `;
      const row = rows[0];
      const parsed = parseAutoLockStored(row?.value);
      const state: AutoLockSwitchState = {
        paused: parsed.paused,
        since: row?.updatedAt ?? null,
        reason: parsed.reason,
        by: parsed.by,
      };
      // Cache ONLY paused: an unpaused result must be re-read so a re-pause is seen at once.
      this.cached = state.paused
        ? { value: state, expiresAt: now + AutoLockSwitchService.CACHE_TTL_MS }
        : null;
      return state;
    } catch (err) {
      this.logger.error(
        "Failed to read platform.autoLocksPaused - treating as PAUSED",
        err as Error,
      );
      return { paused: true, since: null, reason: null, by: null };
    }
  }

  /** Super admin only (the controller): writes the switch with its reason and actor, then refreshes the cache. */
  async setPaused(
    paused: boolean,
    reason: string,
    actor: string | null,
  ): Promise<AutoLockSwitchState> {
    const at = new Date();
    const value = JSON.stringify({ paused, reason, by: actor, at: at.toISOString() });
    await this.prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, ${AUTO_LOCKS_PAUSED_KEY}, ${value}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;
    this.invalidate();
    return this.getState();
  }

  invalidate(): void {
    this.cached = null;
  }
}
