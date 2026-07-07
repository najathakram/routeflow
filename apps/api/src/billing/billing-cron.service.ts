import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { TenantPlan } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney } from "../common/pricing";
import { EntitlementsService } from "./entitlements.service";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { BILLING_EVENTS } from "./plan-catalog.constants";

/** Add whole months (or a year) to a UTC date, clamping the day to the target month. */
function addCycle(from: Date, cycle: string): Date {
  const day = from.getUTCDate();
  const d = new Date(
    Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + (cycle === "ANNUAL" ? 12 : 1), 1),
  );
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

/** 7-day soft-cap grace window. */
const GRACE_DAYS = 7;

/**
 * Plan lifecycle crons (Plans & Billing Phase 5). Operate cross-tenant with explicit
 * tenantId filters (no request context / ALS). Each transition emits a BillingEvent
 * and invalidates the entitlement + tenant-status caches so effects take hold promptly.
 */
@Injectable()
export class BillingCronService {
  private readonly logger = new Logger(BillingCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: BillingEventService,
    private readonly entitlements: EntitlementsService,
    private readonly tenantStatus: TenantStatusGuard,
    private readonly catalog: PlanCatalogService,
  ) {}

  private planMonthly(version: PlanVersionWithCatalog | null, planKey: string | null): number {
    if (!version || !planKey) return 0;
    const d = version.definitions.find((x) => x.planKey === planKey);
    return d?.monthlyPrice != null ? Number(d.monthlyPrice) : 0;
  }

  /** Trial expiry → READ_ONLY (NOT suspended — exports + sign-in still work). */
  @Cron(CronExpression.EVERY_HOUR)
  async expireTrials(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.tenant.findMany({
      where: { status: "TRIAL", trialEndsAt: { lt: now }, deletedAt: null },
      select: { id: true },
    });
    for (const t of expired) {
      await this.prisma.tenant.update({
        where: { id: t.id },
        data: { status: "READ_ONLY", readOnlyReason: "trial_expired" },
      });
      await this.events.emit(t.id, BILLING_EVENTS.TRIAL_EXPIRED, { at: now.toISOString() });
      this.entitlements.invalidate(t.id);
      this.tenantStatus.invalidate(t.id);
    }
    if (expired.length) this.logger.log(`Expired ${expired.length} trials → READ_ONLY`);
  }

  /** Clear soft-cap grace windows older than 7 days (new over-cap work queues afterward). */
  @Cron(CronExpression.EVERY_HOUR)
  async expireGrace(): Promise<void> {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
    const subs = await this.prisma.tenantSubscription.findMany({
      where: { graceStartedAt: { not: null, lt: cutoff } },
      select: { tenantId: true },
    });
    for (const s of subs) {
      await this.prisma.tenantSubscription.update({
        where: { tenantId: s.tenantId },
        data: { graceStartedAt: null, graceMeter: null },
      });
      await this.events.emit(s.tenantId, BILLING_EVENTS.GRACE_EXPIRED, {});
      this.entitlements.invalidate(s.tenantId);
    }
    if (subs.length) this.logger.log(`Expired ${subs.length} grace windows`);
  }

  /** Apply scheduled downgrades whose effective date has passed. Nothing is deleted;
   *  non-retained team users are deactivated (freeing seats), over-cap data goes read-only. */
  @Cron("0 2 * * *")
  async applyScheduledDowngrades(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      where: { downgradeEffectiveAt: { not: null, lte: now }, downgradeToPlanKey: { not: null } },
      select: {
        tenantId: true,
        planKey: true,
        planVersionId: true,
        downgradeToPlanKey: true,
        retainedUserIds: true,
      },
    });
    let applied = 0;
    for (const s of subs) {
      const target = s.downgradeToPlanKey as string;
      // Price the MRR delta + caps from the tenant's PINNED version (grandfathering),
      // not the published one. Skip loudly if the catalog can't be resolved.
      let version;
      try {
        version = await this.catalog.getVersionForTenant(s.planVersionId);
      } catch {
        this.logger.error(`Skipping downgrade for ${s.tenantId} — catalog unresolvable`);
        continue;
      }
      const targetDef = version.definitions.find((d) => d.planKey === target);
      const amountDelta = roundMoney(
        this.planMonthly(version, target) - this.planMonthly(version, s.planKey),
      );
      const seatCap = targetDef?.seatsIncluded ?? null;

      await this.prisma.$transaction(async (tx) => {
        await tx.tenantSubscription.update({
          where: { tenantId: s.tenantId },
          data: {
            planKey: target,
            currentPlan: target as TenantPlan,
            basePriceSnapshot: targetDef?.monthlyPrice ?? null,
            downgradeToPlanKey: null,
            downgradeEffectiveAt: null,
            retainedUserIds: [],
          },
        });
        await tx.tenant.update({ where: { id: s.tenantId }, data: { plan: target as TenantPlan } });
        // Free seats ONLY when over the new cap (deactivate non-retained OPERATOR/DRIVER;
        // TENANT_ADMIN is never deactivated). An empty retained list = keep only admins.
        if (seatCap != null) {
          const activeTeam = await tx.user.count({
            where: {
              tenantId: s.tenantId,
              role: { in: ["TENANT_ADMIN", "OPERATOR", "DRIVER"] },
              status: "ACTIVE",
              deletedAt: null,
            },
          });
          if (activeTeam > seatCap) {
            const freed = await tx.user.updateMany({
              where: {
                tenantId: s.tenantId,
                role: { in: ["OPERATOR", "DRIVER"] },
                status: "ACTIVE",
                deletedAt: null,
                id: { notIn: s.retainedUserIds },
              },
              data: { status: "INACTIVE" },
            });
            if (freed.count > 0) {
              await this.events.emit(
                s.tenantId,
                BILLING_EVENTS.SEAT_FREED,
                { quantity: freed.count },
                { tx },
              );
            }
          }
        }
        await this.events.emit(
          s.tenantId,
          BILLING_EVENTS.PLAN_CHANGED,
          { fromPlan: s.planKey, toPlan: target, scheduled: true, applied: true },
          { amountDelta, tx },
        );
      });
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
      applied++;
    }
    if (applied) this.logger.log(`Applied ${applied} scheduled downgrades`);
  }

  /** End access for self-cancelled subscriptions whose period has ended → READ_ONLY
   *  (data intact, exports + sign-in + re-subscribe still work). */
  @Cron(CronExpression.EVERY_HOUR)
  async applyScheduledCancellations(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      where: {
        cancelAtPeriodEnd: true,
        periodEnd: { not: null, lt: now },
        tenant: { status: "ACTIVE", deletedAt: null },
      },
      select: { tenantId: true },
    });
    for (const s of subs) {
      await this.prisma.tenant.update({
        where: { id: s.tenantId },
        data: { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
      });
      await this.events.emit(s.tenantId, BILLING_EVENTS.SUBSCRIPTION_CANCELED, {
        appliedAt: now.toISOString(),
      });
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
    }
    if (subs.length) this.logger.log(`Applied ${subs.length} scheduled cancellations → READ_ONLY`);
  }

  /** Advance billing periods past their end so SCANS/MSGS meters bucket into the new
   *  cycle (bucketed by periodStart, so a new period reads 0 automatically). */
  @Cron("5 0 * * *")
  async rollCycles(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      where: {
        periodEnd: { not: null, lt: now },
        planKey: { not: null },
        cancelAtPeriodEnd: false,
      },
      select: { tenantId: true, cycle: true, periodEnd: true },
    });
    for (const s of subs) {
      const start = s.periodEnd as Date;
      await this.prisma.tenantSubscription.update({
        where: { tenantId: s.tenantId },
        data: { periodStart: start, periodEnd: addCycle(start, s.cycle) },
      });
    }
    if (subs.length) this.logger.log(`Rolled ${subs.length} billing cycles`);
  }
}
