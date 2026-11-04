import { Injectable, Logger } from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { OwnerAlertService } from "../email/owner-alert.service";
import { includedAtPlanVerdict } from "./addon-catalog-invalid";
import {
  FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
  FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
  FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED,
} from "./feature-override-audit.constants";
import { FEATURE_REGISTRY, featureDefByKey } from "./feature-registry";
import { PlanCatalogService, type PlanVersionWithCatalog } from "./plan-catalog.service";

// Re-exported: the constant's home is `feature-override-audit.constants.ts` (shared with the sweep).
export { FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION };

/** Per-tick cap (pre-merge review, SHOULD-2026-09-17): bounds one tick's cost when a large
 * backlog of expired-unrevoked rows exists. Oldest-`expiresAt`-first (`orderBy`) so a backlog
 * larger than the cap still drains in FIFO order across successive nightly ticks. */
const REVIEW_BATCH_SIZE = 500;

/** Bound on the "already audited" id lookup (pre-merge re-review, STARVATION-2026-09-17): once
 * >= REVIEW_BATCH_SIZE older rows are already audited and still unrevoked, excluding them AFTER
 * fetching a fixed-size oldest-first page starves every newer row forever -- the same oldest
 * page wins every tick. Excluding them INSIDE the selection query (`id: { notIn }`) fixes that,
 * but needs the audited-id set fetched first; bounded (not unbounded) so that lookup itself
 * can't grow without limit. A backlog of more than this many already-audited-and-still-unrevoked
 * rows is an operational problem (nobody is revoking) this job cannot fully solve alone. */
const AUDIT_LOOKUP_BOUND = 5000;

/** R25: the owner is told this long before a billable free period ends. */
const PILOT_WARNING_DAYS = 7;

/** Registry features that have a paid add-on at all: only these can ever cost money when a free period ends. */
const FEATURE_KEYS_WITH_SKU: readonly string[] = FEATURE_REGISTRY.filter(
  (f) => f.billing.skus.length > 0,
).map((f) => f.key);

/**
 * Nightly review sweep for feature grants v2 (brief B, research §6.4): flags every
 * non-revoked `TenantFeatureOverride` whose `expiresAt` has passed. Writes ONE audit row per
 * row, EVER — not once per night. A row that already has a `FEATURE_OVERRIDE_EXPIRED_REVIEW`
 * audit entry is skipped on every later tick (pre-merge review, SHOULD-2026-09-17: re-auditing
 * an unchanged, still-not-reviewed row nightly is pure noise, not a stronger signal), so the
 * audit trail carries exactly one row per override, however many nights it stays unrevoked.
 *
 * THIS job never revokes — it only flags. Closing an expired row is the separate B569 sweep
 * (`FeatureOverrideExpiryJob`, 06:30), which only takes rows this job has already flagged.
 * A human calling `FeatureOverrideService.revoke()` still ends an
 * override at any time.
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
    private readonly ownerAlerts: OwnerAlertService,
    private readonly catalog: PlanCatalogService,
  ) {}

  @LeaderCron("0 6 * * *", "billing.reviewExpiredOverrides")
  async reviewExpiredOverrides(): Promise<{ reviewed: number }> {
    const now = new Date();

    // Fetched FIRST and excluded INSIDE the selection query below (not a post-fetch filter on
    // a fixed-size page) -- the audit log has no dedicated "reviewed" column, so this IS the
    // once-ever contract's source of truth, and it must shape which rows the page below can
    // even select, not just which of an already-decided page get skipped.
    const auditedRows = await this.prisma.auditLog.findMany({
      where: {
        action: FEATURE_OVERRIDE_EXPIRED_REVIEW_ACTION,
        entityType: FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
      },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LOOKUP_BOUND,
      select: { entityId: true },
    });
    const auditedIds = auditedRows
      .map((row) => row.entityId)
      .filter((id): id is string => id != null);

    const expired = await this.prisma.tenantFeatureOverride.findMany({
      where: {
        revokedAt: null,
        expiresAt: { lte: now },
        ...(auditedIds.length > 0 ? { id: { notIn: auditedIds } } : {}),
      },
      // `id` tiebreak: rows sharing an expiresAt (bulk grants) must not reorder between ticks.
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: REVIEW_BATCH_SIZE,
      select: {
        id: true,
        tenantId: true,
        featureKey: true,
        kind: true,
        effect: true,
        expiresAt: true,
      },
    });

    if (expired.length >= REVIEW_BATCH_SIZE) {
      // A full page is indistinguishable from an empty backlog from outside — say so.
      this.logger.warn(
        `reviewExpiredOverrides hit its batch cap of ${REVIEW_BATCH_SIZE} — more expired ` +
          `overrides may be waiting for review; the next tick continues from the oldest.`,
      );
    }

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
        entityType: FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
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

  /**
   * R25: tells the owner by email, ONCE per override and end date, that a billable free period (a non-revoked PILOT
   * GRANT whose feature has a paid add-on) ends within 7 days. Read-only on overrides: it never revokes anything and
   * never touches a price or a plan. A free period that is extended earns a new warning (new end date).
   *
   * "Already warned" is one audit row per (override id, end date). The audit row is written with prisma directly (not
   * AuditService.log, which swallows its own failure) and BEFORE the mail: if the row cannot be written, nothing is
   * sent, so a business is warned at most once. The warned pairs are fetched first (bounded) and excluded INSIDE the
   * selection query, the same starvation guard as reviewExpiredOverrides.
   */
  @LeaderCron("30 6 * * *", "billing.warnBillablePilotsEnding")
  async warnBillablePilotsEnding(): Promise<{ warned: number }> {
    const now = new Date();
    const horizon = new Date(now.getTime() + PILOT_WARNING_DAYS * 24 * 60 * 60 * 1000);

    const noticeRows = await this.prisma.auditLog.findMany({
      where: {
        action: FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED,
        entityType: FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
        // a warning only matters while its end date is still ahead; older rows can never match a candidate
        createdAt: { gte: new Date(now.getTime() - 2 * PILOT_WARNING_DAYS * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: AUDIT_LOOKUP_BOUND,
      select: { entityId: true, meta: true },
    });
    const warned: { id: string; expiresAt: Date }[] = [];
    for (const r of noticeRows) {
      const at = new Date(String((r.meta as { expiresAt?: unknown } | null)?.expiresAt ?? ""));
      if (r.entityId && !Number.isNaN(at.getTime())) warned.push({ id: r.entityId, expiresAt: at });
    }

    const ending = await this.prisma.tenantFeatureOverride.findMany({
      where: {
        kind: "PILOT",
        effect: "GRANT",
        revokedAt: null,
        expiresAt: { gt: now, lte: horizon },
        featureKey: { in: [...FEATURE_KEYS_WITH_SKU] },
        tenant: { deletedAt: null },
        ...(warned.length > 0 ? { NOT: warned } : {}),
      },
      orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
      take: REVIEW_BATCH_SIZE,
      select: {
        id: true,
        tenantId: true,
        featureKey: true,
        expiresAt: true,
        tenant: {
          select: {
            plan: true,
            planVersionId: true,
            subscription: { select: { planKey: true, planVersionId: true } },
          },
        },
      },
    });
    if (ending.length >= REVIEW_BATCH_SIZE) {
      this.logger.warn(
        `warnBillablePilotsEnding hit its batch cap of ${REVIEW_BATCH_SIZE} — more free periods may be waiting for a warning; the next tick continues.`,
      );
    }

    const catalogs = new Map<string | null, PlanVersionWithCatalog | null>();
    let sent = 0;
    for (const row of ending) {
      try {
        if (!row.expiresAt) continue;
        const pin = row.tenant.subscription?.planVersionId ?? row.tenant.planVersionId ?? null;
        if (!catalogs.has(pin)) {
          catalogs.set(pin, await this.catalog.getVersionForTenant(pin).catch(() => null));
        }
        const version = catalogs.get(pin);
        const skus = featureDefByKey(row.featureKey)?.billing.skus ?? [];
        const planKey = row.tenant.subscription?.planKey ?? row.tenant.plan;
        const paid = version?.addonSkus.find(
          (s) =>
            skus.includes(s.sku) &&
            Number(s.monthlyPrice) > 0 &&
            includedAtPlanVerdict(s, planKey).kind === "NOT_INCLUDED",
        );
        if (!paid) continue;

        // Audit FIRST: a row that cannot be written means no mail (at most once).
        await this.prisma.auditLog.create({
          data: {
            tenantId: row.tenantId,
            userId: null,
            action: FEATURE_OVERRIDE_PILOT_ENDING_NOTIFIED,
            entityType: FEATURE_OVERRIDE_AUDIT_ENTITY_TYPE,
            entityId: row.id,
            meta: { expiresAt: row.expiresAt },
          },
        });
        await this.ownerAlerts.pilotEnding(row.tenantId, {
          featureName: paid.name,
          endsAt: row.expiresAt,
          monthlyPrice: Number(paid.monthlyPrice),
        });
        sent++;
      } catch (err) {
        this.logger.warn(
          `Pilot-ending warning for override ${row.id} not sent: ${(err as Error)?.message ?? err}`,
        );
      }
    }
    return { warned: sent };
  }
}
