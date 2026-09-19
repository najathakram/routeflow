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
 * A row is swept only once it has been expired for a full review cycle. The review job
 * (`billing.reviewExpiredOverrides`, daily 06:00) flags each expired-unrevoked row exactly once
 * ever; a row that expired at, say, 06:10 would be revoked by today's 06:30 sweep BEFORE the
 * review job ever saw it (its `revokedAt: null` filter would exclude it from then on), silently
 * skipping the audit row that job promises. Requiring `expiresAt <= now - 24h` guarantees at
 * least one 06:00 review tick fell between expiry and revocation. Cost: the unique-index slot
 * frees up to ~24h after expiry (reads already ignore an expired row via `effectAt()`, and
 * `create()` still auto-closes an expired same-key row immediately, so only bulk writers wait).
 */
export const EXPIRY_GRACE_MS = 24 * 60 * 60 * 1000;

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
 * Runs at 06:30 and only takes rows expired for at least `EXPIRY_GRACE_MS`, so
 * `billing.reviewExpiredOverrides` (06:00) has always flagged a row — its once-ever "expired and
 * still unrevoked" audit entry — before this job closes it.
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
    const revoked = await this.overrides.revokeExpired(new Date(), { graceMs: EXPIRY_GRACE_MS });

    for (const row of revoked) {
      this.logger.log(
        `Feature override ${row.id} (tenant ${row.tenantId}, key "${row.featureKey}", ` +
          `kind ${row.kind}) expired at ${row.expiresAt?.toISOString()} — revoked.`,
      );
      // AuditService.log() catches and logs its own failures and never rejects, so a failed audit
      // write cannot abandon the rest of the batch (the revokes are committed either way).
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
    }

    return { revoked: revoked.length };
  }
}
