import { Injectable, Logger } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney } from "@routeflow/pricing";
import { EntitlementsService } from "./entitlements.service";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { MeterService } from "./meter.service";
import {
  BILLING_EVENTS,
  findPlanDefinition,
  GRACE_DAYS,
  planKeyToEnum,
} from "./plan-catalog.constants";
import { addCycle } from "./billing-math";

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
    private readonly meters: MeterService,
  ) {}

  private planMonthly(version: PlanVersionWithCatalog | null, planKey: string | null): number {
    if (!version || !planKey) return 0;
    const d = findPlanDefinition(version.definitions, planKey);
    return d?.monthlyPrice != null ? Number(d.monthlyPrice) : 0;
  }

  /** Trial expiry → READ_ONLY (NOT suspended — exports + sign-in still work). */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.expireTrials")
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

  /**
   * Clear soft-cap grace windows older than {@link GRACE_DAYS} (new over-cap work queues
   * afterward).
   *
   * A CUSTOMERS window is the exception: it is left in place while the tenant is STILL
   * over cap. Clearing it reads as "no grace window was ever opened" to the synchronous
   * customer-create gate, which would then open a brand-new window on the very next
   * create — a tenant could sit indefinitely over its customer cap, blocked for at most
   * the hour between this cron tick and the next create. The window is cleared (and
   * grace.expired emitted) as soon as the tenant is back within cap, e.g. after buying a
   * CUSTOMER_PACK_100, upgrading, or deleting customers.
   */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.expireGrace")
  async expireGrace(): Promise<void> {
    const cutoff = new Date(Date.now() - GRACE_DAYS * 24 * 60 * 60 * 1000);
    const subs = await this.prisma.tenantSubscription.findMany({
      where: { graceStartedAt: { not: null, lt: cutoff } },
      select: { tenantId: true, graceMeter: true },
    });
    let cleared = 0;
    for (const s of subs) {
      if (s.graceMeter === "CUSTOMERS" && (await this.stillOverCustomerCap(s.tenantId))) continue;
      await this.prisma.tenantSubscription.update({
        where: { tenantId: s.tenantId },
        data: { graceStartedAt: null, graceMeter: null },
      });
      await this.events.emit(s.tenantId, BILLING_EVENTS.GRACE_EXPIRED, {});
      this.entitlements.invalidate(s.tenantId);
      cleared++;
    }
    if (cleared) this.logger.log(`Expired ${cleared} grace windows`);
  }

  /** Is the tenant still above its CUSTOMERS cap? A failed lookup answers `false` so a
   *  billing/catalog outage releases the window rather than stranding the tenant behind
   *  the create gate (same fail-open rule the gate itself applies). */
  private async stillOverCustomerCap(tenantId: string): Promise<boolean> {
    try {
      const reading = await this.meters.read(tenantId, "CUSTOMERS");
      return reading.included != null && reading.used > reading.included;
    } catch (err) {
      this.logger.warn(`Customer cap lookup failed for tenant ${tenantId}; expiring grace.`, err);
      return false;
    }
  }

  /** Apply scheduled downgrades whose effective date has passed. Nothing is deleted;
   *  non-retained team users are deactivated (freeing seats), over-cap data goes read-only. */
  @LeaderCron("0 2 * * *", "billing-cron.applyScheduledDowngrades")
  async applyScheduledDowngrades(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      // Same tenant filter as applyScheduledCancellations below: a SUSPENDED / CANCELLED /
      // soft-deleted tenant has already had its churn delta booked, so applying a schedule left
      // on it would book a SECOND PLAN_CHANGED delta against a non-paying tenant (MRR = Σ
      // amountDelta never self-heals) and deactivate the operators/drivers of a deleted tenant.
      where: {
        downgradeEffectiveAt: { not: null, lte: now },
        downgradeToPlanKey: { not: null },
        tenant: { status: "ACTIVE", deletedAt: null },
      },
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
      let version: PlanVersionWithCatalog;
      try {
        version = await this.catalog.getVersionForTenant(s.planVersionId);
      } catch {
        this.logger.error(`Skipping downgrade for ${s.tenantId} — catalog unresolvable`);
        continue;
      }
      const targetDef = findPlanDefinition(version.definitions, target);
      const amountDelta = roundMoney(
        this.planMonthly(version, target) - this.planMonthly(version, s.planKey),
      );
      const seatCap = targetDef?.seatsIncluded ?? null;

      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.tenantSubscription.update({
            where: { tenantId: s.tenantId },
            data: {
              planKey: target,
              // B218: `target` came from a PAST downgrade()/updatePlan() write, which already
              // validates against the catalog — but this row can also be old, migrated, or
              // manually edited data pointing at a plan key that no longer resolves. planKeyToEnum()
              // now THROWS instead of silently writing STARTER for such a key; caught below so ONE
              // bad row never stops the sweep from applying every other tenant's downgrade.
              currentPlan: planKeyToEnum(target),
              basePriceSnapshot: targetDef?.monthlyPrice ?? null,
              downgradeToPlanKey: null,
              downgradeEffectiveAt: null,
              retainedUserIds: [],
            },
          });
          await tx.tenant.update({
            where: { id: s.tenantId },
            data: { plan: planKeyToEnum(target) },
          });
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
      } catch (err) {
        // B218: log and move on — a cron that dies on tenant N's bad row would silently
        // strand every tenant after it unapplied too, which is worse than the one bad row.
        this.logger.error(
          `Skipping scheduled downgrade for tenant=${s.tenantId} target="${target}" — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      }
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
      applied++;
    }
    if (applied) this.logger.log(`Applied ${applied} scheduled downgrades`);
  }

  /** End access for self-cancelled subscriptions whose period has ended → READ_ONLY
   *  (data intact, exports + sign-in + re-subscribe still work). */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.applyScheduledCancellations")
  async applyScheduledCancellations(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      where: {
        cancelAtPeriodEnd: true,
        periodEnd: { not: null, lt: now },
        tenant: { status: "ACTIVE", deletedAt: null },
      },
      select: { tenantId: true, basePriceSnapshot: true, discount: true },
    });
    for (const s of subs) {
      // The run-rate this tenant stops contributing once access ends → emit it as a NEGATIVE
      // MRR delta (base + active add-ons − discount) so the append-only ledger nets down with
      // churn instead of over-counting the tenant's last plan forever.
      const addons = await this.prisma.tenantAddon.findMany({
        where: { tenantId: s.tenantId, active: true },
        select: { priceSnapshot: true, quantity: true },
      });
      const addonMrr = addons.reduce(
        (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
        0,
      );
      const contribution = roundMoney(
        (s.basePriceSnapshot != null ? Number(s.basePriceSnapshot) : 0) +
          addonMrr -
          Number(s.discount ?? 0),
      );
      await this.prisma.tenant.update({
        where: { id: s.tenantId },
        data: { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
      });
      // Deactivate the cancelled subscription's add-ons: the negative delta above already
      // removed their run-rate, so the rows must follow suit — otherwise a later reactivation
      // via subscribe() sees them still-active (deltaQty=0) and never re-adds the +add-on delta,
      // drifting the ledger below the snapshot. (A non-paying tenant holding "active" paid
      // add-ons is itself incorrect state.)
      // NOTE for support: this drops admin-granted "ships dark" SKUs too (MSRP, SALES_AGENTS,
      // REGULATED_ITEMS). They are outside SELF_SERVICE_ADDON_SKUS, so a re-subscribe cannot
      // bring them back — platform-admin must re-grant them after the tenant reactivates.
      await this.prisma.tenantAddon.updateMany({
        where: { tenantId: s.tenantId, active: true },
        data: { active: false },
      });
      await this.events.emit(
        s.tenantId,
        BILLING_EVENTS.SUBSCRIPTION_CANCELED,
        { appliedAt: now.toISOString() },
        { amountDelta: contribution ? -contribution : 0 },
      );
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
    }
    if (subs.length) this.logger.log(`Applied ${subs.length} scheduled cancellations → READ_ONLY`);
  }

  /** Advance billing periods past their end so SCANS/MSGS meters bucket into the new
   *  cycle (bucketed by periodStart, so a new period reads 0 automatically).
   *
   *  B329, time-of-day half (fixed here): a rolled `periodEnd` used to collapse to
   *  midnight; `addCycle`/`addMonthsUtc` (billing-math.ts) now preserve `periodEnd`'s
   *  hours/minutes/seconds/ms exactly.
   *
   *  B329, anchor-ratchet half (NOT fixed here — correction 2026-09-13): `periodEnd`
   *  gets overwritten with a clamped value on every roll (Jan 31 → Feb 28), and
   *  re-deriving the clamp day from THAT already-clamped `periodEnd` on the next roll
   *  ratchets the anchor down forever (Feb 28 → Mar 28, never back to the 31st).
   *  `addMonthsUtc` takes an `anchorDay` override that would fix this, but there is no
   *  persisted, never-clamped billing-anchor-day column to pass it —
   *  `TenantSubscription.createdAt` is NOT a safe substitute: seven call sites create
   *  this row, and several have nothing to do with subscribing (e.g.
   *  `customers.service.ts`'s `maybeStartCustomerGrace()` mints one when a tenant
   *  crosses the customer soft cap; `billing.service.ts`'s `ensureStripeCustomer()`
   *  mints one on first Stripe customer creation) — using either would compute every
   *  future period off a date that has nothing to do with the tenant's real billing
   *  anchor. So this stays byte-identical to master's ratchet behaviour (the clamp day
   *  is re-derived from the period being rolled, i.e. `addCycle`'s own default) until
   *  an immutable `anchorDay` column exists; that is filed separately. */
  @LeaderCron("5 0 * * *", "billing-cron.rollCycles")
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
