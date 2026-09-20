import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
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
 * `revokedAt` writes, which also drops the affected tenants' 30s cache); this job schedules it and
 * audits each revoked row with `meta.reason = "expired"` — INSIDE that row's own transaction
 * (B580), so a row is never revoked without its audit row nor audited without being revoked.
 *
 * Idempotent: a revoked row no longer matches, so a re-run revokes nothing and audits nothing.
 * A row with no `expiresAt` (a standing grant) never matches and is never touched.
 *
 * Runs at 06:30 and only takes rows `billing.reviewExpiredOverrides` (06:00) has ALREADY flagged —
 * its once-ever "expired and still unrevoked" audit row must exist (B589). That is a state check,
 * not the old 24h time proxy: a missed 06:00 tick can no longer let a row be revoked unflagged
 * (its review audit is then lost for good, since the review job only reads unrevoked rows); the
 * sweep just waits for the flag.
 *
 * Cross-tenant by design, like the review job: the plain global `PrismaService`, never
 * `forTenant()`, so L-124's ambient-tenant trap does not apply.
 */
@Injectable()
export class FeatureOverrideExpiryJob {
  private readonly logger = new Logger(FeatureOverrideExpiryJob.name);

  constructor(private readonly overrides: FeatureOverrideService) {}

  @LeaderCron("30 6 * * *", "billing.revokeExpiredOverrides")
  async revokeExpiredOverrides(): Promise<{ revoked: number }> {
    const revoked = await this.overrides.revokeExpired(new Date(), {
      graceMs: 0, // the review-flag gate, not elapsed time, decides when a row may be swept
      // Written with `tx.auditLog.create` (not AuditService.log, which swallows its own errors
      // and has no transaction handle): a failed audit write must roll the revoke back.
      inTransaction: async (tx, row) => {
        await tx.auditLog.create({
          data: {
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
          },
        });
      },
    });

    for (const row of revoked) {
      this.logger.log(
        `Feature override ${row.id} (tenant ${row.tenantId}, key "${row.featureKey}", ` +
          `kind ${row.kind}) expired at ${row.expiresAt?.toISOString()} — revoked.`,
      );
    }

    return { revoked: revoked.length };
  }
}
