import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

const FLAG_KEY = "entitlements.configSnapshot";

/**
 * The LIVE, platform-wide on/off switch for automatic entitlement-config snapshot/restore on plan
 * changes (Lane B A2; lead decision 2, 2026-09-20). Same store and shape as `EntitlementsModeService`
 * (a `PlatformConfig` row, raw SQL) so the owner can flip it without a redeploy — an env var was
 * the first cut and was replaced for exactly that reason.
 *
 * FAIL-CLOSED: the only value that turns it on is the literal "on" (trimmed, any case). A missing
 * row, any other string ("yes", "true", "1", typos) and any read error all mean OFF, so a broken
 * or half-written value can never enable a feature that writes tenant data during a plan change.
 * An unparseable non-empty value is logged so a typo is visible, not silently ignored.
 *
 * PROPAGATION: reads are cached ~5 s per replica and `setEnabled()` refreshes only the replica that
 * served the write, so a flip takes effect across replicas within ~5 s. A plan change inside that
 * window may still snapshot/restore under the old value — harmless: a snapshot only archives and a
 * restore is idempotent, stamped and never overwrites a newer change.
 */
@Injectable()
export class ConfigSnapshotFlagService {
  private readonly logger = new Logger(ConfigSnapshotFlagService.name);
  private cached: { value: boolean; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    let value = false;
    try {
      const rows = await this.prisma.$queryRaw<{ value: string }[]>`
        SELECT value FROM "PlatformConfig" WHERE key = ${FLAG_KEY} LIMIT 1
      `;
      const raw = rows[0]?.value;
      if (typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        value = v === "on";
        if (!value && v !== "" && v !== "off") {
          this.logger.error(
            `${FLAG_KEY} has an unrecognised value "${raw}" — treating as OFF (only "on" enables it)`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Failed to read ${FLAG_KEY} — treating as OFF`, err as Error);
      // Not cached: a transient read failure must not pin the flag off for the whole TTL.
      return false;
    }
    this.cached = { value, expiresAt: now + ConfigSnapshotFlagService.CACHE_TTL_MS };
    return value;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const value = enabled ? "on" : "off";
    await this.prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, ${FLAG_KEY}, ${value}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;
    this.cached = {
      value: enabled,
      expiresAt: Date.now() + ConfigSnapshotFlagService.CACHE_TTL_MS,
    };
  }

  invalidate(): void {
    this.cached = null;
  }
}
