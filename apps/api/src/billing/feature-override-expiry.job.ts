import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { AuditService } from "../audit/audit.service";
import { FeatureOverrideService } from "./feature-override.service";

/** Audit action for a row this sweep revoked. Deliberately NOT `AdminAuditAction.
 * FEATURE_OVERRIDE_REVOKED` (that code is a human admin's action, keyed to the tenant and read by
 * the platform-admin history UI) — a system-detected expiry gets its own code. */
export const FEATURE_OVERRIDE_EXPIRY_REVOKED_ACTION = "FEATURE_OVERRIDE_EXPIRY_REVOKED";

/** The `reason` recorded in the audit meta for every row this sweep closes. */
export const EXPIRED_REVOKE_REASON = "expired";

/**
 * Nightly expiry sweep (B569): revokes every `TenantFeatureOverride` whose `expiresAt` has
 * passed, so an expired-but-never-revoked row stops occupying the partial unique index
 * (`WHERE revokedAt IS NULL`) that blocks a re-grant/re-deny of the same feature key — a slot
 * only `FeatureOverrideService.create()` ever freed, and only for its own key. Bulk writers
 * (publish-and-repin) and human re-grants through any other path hit the stale row instead.
 *
 * The write itself lives in `FeatureOverrideService.revokeExpired()` (the single choke point for
 * `revokedAt` writes, which also drops the affected tenants' 30s cache); this job only schedules
 * it and audits each revoked row with `meta.reason = "expired"`.
 *
 * Idempotent: a revoked row no longer matches, so a re-run revokes nothing and audits nothing.
 * A row with no `expiresAt` (a standing grant) never matches and is never touched.
 *
 * Runs at 06:30, AFTER `billing.reviewExpiredOverrides` (06:00) has flagged the same rows for
 * review, so the once-ever "expired and still unrevoked" audit row is written before the row
 * stops being unrevoked.
 *
 * Cross-tenant by design, like the review job: the plain global `PrismaService`, never
 * `forTenant()`, so L-124's ambient-tenant trap does not apply.
 */
@Injectable()
export class FeatureOverrideExpiryJob {
  private readonly logger = new Logger(FeatureOverrideExpiryJob.name);

  constructor(
    private readonly overrides: FeatureOverrideService,
    private readonly audit: AuditService,
  ) {}

  @LeaderCron("30 6 * * *", "billing.revokeExpiredOverrides")
  async revokeExpiredOverrides(): Promise<{ revoked: number }> {
    const revoked = await this.overrides.revokeExpired();

    for (const row of revoked) {
      this.logger.log(
        `Feature override ${row.id} (tenant ${row.tenantId}, key "${row.featureKey}", ` +
          `kind ${row.kind}) expired at ${row.expiresAt?.toISOString()} — revoked.`,
      );
      try {
        await this.audit.log({
          tenantId: row.tenantId,
          userId: null,
          action: FEATURE_OVERRIDE_EXPIRY_REVOKED_ACTION,
          entityType: "tenantFeatureOverride",
          entityId: row.id,
          meta: {
            reason: EXPIRED_REVOKE_REASON,
            featureKey: row.featureKey,
            kind: row.kind,
            effect: row.effect,
            expiresAt: row.expiresAt,
          },
        });
      } catch (err) {
        // The revoke is already committed; a failed audit write must not abandon the rest of
        // the batch (they are revoked either way and would otherwise go unaudited).
        this.logger.error(
          `Audit write failed for expired override ${row.id}: ${(err as Error)?.message}`,
        );
      }
    }

    return { revoked: revoked.length };
  }
}
