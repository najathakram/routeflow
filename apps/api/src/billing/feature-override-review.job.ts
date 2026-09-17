import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";

/** Audit action code for a flagged-for-review row — read by nothing else yet (brief B ships
 * API-only), so it is a plain string here rather than an entry in platform-admin's
 * `AdminAuditAction` (that constant is specifically for PlatformAdminService's own tenant-keyed
 * admin-action rows; `AuditService.log()`'s `action` field is a plain string with no registry). */
export const FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION = "FEATURE_OVERRIDE_EXPIRED_REVIEW";

/**
 * Nightly review sweep for feature grants v2 (brief B, research §6.4): flags every
 * non-revoked `TenantFeatureOverride` whose `expiresAt` has passed. Logs + writes ONE audit
 * row per still-expired-and-unrevoked row, every tick — re-flagging an override a human has
 * not yet revoked is the intended behaviour (a review queue, not a one-shot notice), not a bug.
 *
 * NEVER auto-revokes: only a human calling `FeatureOverrideService.revoke()` ends an override.
 * `FeatureOverrideService.create()`'s own auto-close of an expired row is a side-effect of
 * allowing a same-key re-grant, not a policy decision that the override should end — this job
 * makes the same distinction and only ever reads the row.
 *
 * Cross-tenant by design (mirrors `BillingCronService`'s "operate cross-tenant with explicit
 * tenantId filters, no request context / ALS" — L-124 does not apply: this uses the plain
 * global `PrismaService`, never `forTenant()`, so there is no ambient-tenant assumption to miss).
 */
@Injectable()
export class FeatureOverrideReviewJob {
  private readonly logger = new Logger(FeatureOverrideReviewJob.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @LeaderCron("0 6 * * *", "billing.reviewExpiredOverrides")
  async reviewExpiredOverrides(): Promise<{ reviewed: number }> {
    const now = new Date();
    const expired = await this.prisma.tenantFeatureOverride.findMany({
      where: { revokedAt: null, expiresAt: { lte: now } },
      select: {
        id: true,
        tenantId: true,
        featureKey: true,
        kind: true,
        effect: true,
        expiresAt: true,
      },
    });

    for (const row of expired) {
      this.logger.warn(
        `Feature override ${row.id} (tenant ${row.tenantId}, key "${row.featureKey}", ` +
          `kind ${row.kind}) expired at ${row.expiresAt?.toISOString()} and is still not ` +
          `revoked — flagged for review.`,
      );
      // entityType is the override row itself (not "tenant"/ADMIN_AUDIT_ENTITY) -- this is a
      // system-detected flag, not an admin action on a tenant, so it gets its own entity shape.
      await this.audit.log({
        tenantId: row.tenantId,
        userId: null,
        action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
        entityType: "tenantFeatureOverride",
        entityId: row.id,
        meta: {
          featureKey: row.featureKey,
          kind: row.kind,
          effect: row.effect,
          expiresAt: row.expiresAt,
        },
      });
    }

    return { reviewed: expired.length };
  }
}
