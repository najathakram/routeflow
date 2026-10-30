import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

export const CARD_FIRST_FLAG_KEY = "billing.cardFirstPlanPick";

/**
 * SA-774 (card first, then active): the LIVE, platform-wide dark switch for routing a card-less business's
 * plan pick through Stripe Checkout. It ships OFF and is flipped by the owner (no per-tenant flag: owner
 * ruling 2026-10-25). Same store, shape and fail-closed rules as `ConfigSnapshotFlagService` (a
 * `PlatformConfig` row read with raw SQL, a standalone service so `BillingModule` has no cycle): only the
 * literal "on" (trimmed, any case) turns it on; a missing row, any other value and any read error mean OFF.
 * Reads are cached ~5 s per replica; a read failure is not cached.
 */
@Injectable()
export class CardFirstFlagService {
  private readonly logger = new Logger(CardFirstFlagService.name);
  private cached: { value: boolean; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  async isEnabled(): Promise<boolean> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    let value = false;
    try {
      const rows = await this.prisma.$queryRaw<{ value: string }[]>`
        SELECT value FROM "PlatformConfig" WHERE key = ${CARD_FIRST_FLAG_KEY} LIMIT 1
      `;
      const raw = rows[0]?.value;
      if (typeof raw === "string") {
        const v = raw.trim().toLowerCase();
        value = v === "on";
        if (!value && v !== "" && v !== "off") {
          this.logger.error(
            `${CARD_FIRST_FLAG_KEY} has an unrecognised value "${raw}" - treating as OFF (only "on" enables it)`,
          );
        }
      }
    } catch (err) {
      this.logger.error(`Failed to read ${CARD_FIRST_FLAG_KEY} - treating as OFF`, err as Error);
      return false;
    }
    this.cached = { value, expiresAt: now + CardFirstFlagService.CACHE_TTL_MS };
    return value;
  }

  async setEnabled(enabled: boolean): Promise<void> {
    const value = enabled ? "on" : "off";
    await this.prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, ${CARD_FIRST_FLAG_KEY}, ${value}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;
    this.cached = { value: enabled, expiresAt: Date.now() + CardFirstFlagService.CACHE_TTL_MS };
  }

  invalidate(): void {
    this.cached = null;
  }
}
