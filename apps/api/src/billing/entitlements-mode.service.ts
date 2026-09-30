import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import type { EntitlementsMode } from "@routeflow/types";

const MODE_KEY = "entitlements.mode";

/**
 * Design 2026-09-17 §2 "Switch + rollback": the global (NOT tenant-scoped) shadow/live switch.
 * Stored in the existing `PlatformConfig` table (same raw-SQL pattern as
 * platform-admin/platform-config.service.ts's AI-config keys) rather than the tenant-scoped
 * SystemConfigService — entitlements.mode governs every tenant at once, so a per-tenant store
 * would be the wrong shape entirely. A standalone service (not a PlatformConfigService method)
 * to avoid a new cross-module edge from EntitlementsModule/BillingModule back to
 * PlatformAdminModule, which already depends on BillingModule the other way.
 */
@Injectable()
export class EntitlementsModeService {
  private readonly logger = new Logger(EntitlementsModeService.name);
  private cached: { value: EntitlementsMode; expiresAt: number } | null = null;
  private static readonly CACHE_TTL_MS = 5_000;

  constructor(private readonly prisma: PrismaService) {}

  /** Defaults to "shadow" — the safe, zero-enforcement-change starting state. */
  async getMode(): Promise<EntitlementsMode> {
    const now = Date.now();
    if (this.cached && this.cached.expiresAt > now) return this.cached.value;
    try {
      const rows = await this.prisma.$queryRaw<{ value: string }[]>`
        SELECT value FROM "PlatformConfig" WHERE key = ${MODE_KEY} LIMIT 1
      `;
      const value: EntitlementsMode = rows[0]?.value === "live" ? "live" : "shadow";
      this.cached = { value, expiresAt: now + EntitlementsModeService.CACHE_TTL_MS };
      return value;
    } catch (err) {
      this.logger.error("Failed to read entitlements.mode — defaulting to shadow", err as Error);
      return "shadow";
    }
  }

  async setMode(mode: EntitlementsMode): Promise<void> {
    await this.prisma.$executeRaw`
      INSERT INTO "PlatformConfig" ("id", "key", "value", "updatedAt")
        VALUES (gen_random_uuid()::text, ${MODE_KEY}, ${mode}, now())
      ON CONFLICT ("key")
        DO UPDATE SET "value" = EXCLUDED.value, "updatedAt" = now()
    `;
    this.cached = { value: mode, expiresAt: Date.now() + EntitlementsModeService.CACHE_TTL_MS };
  }

  invalidate(): void {
    this.cached = null;
  }
}
