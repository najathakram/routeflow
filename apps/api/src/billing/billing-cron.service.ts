import { priceOverrideOf, sameOverride } from "./price-override";
import { Injectable, Logger, Optional } from "@nestjs/common";
import { CronExpression } from "@nestjs/schedule";
import { LeaderCron } from "../common/cron-lock";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney, toCents } from "@routeflow/pricing";
import { EntitlementsService } from "./entitlements.service";
import { BillingEventService } from "./billing-event.service";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { MeterService } from "./meter.service";
import {
  BILLING_EVENTS,
  findPlanDefinition,
  GRACE_DAYS,
  PlanNotInCatalogError,
  normalizePlanKey,
  planKeyFromEnum,
  planKeyToEnum,
  UnknownPlanKeyError,
} from "./plan-catalog.constants";
import { addCycle } from "./billing-math";
import { billableAddonWhere } from "./addon-row";
import { effectiveCycle, nextBillingWindow } from "./rf-invoice/calendar-windows";
import { lockTenantForLedger } from "./addon-ledger";
import { isPayingRow } from "./mrr.service";
import { BillingNotificationService } from "./billing-notification.service";
import { PlanTransitionConfigService, SnapshotFailedError } from "./plan-transition-config.service";
import { StripeService } from "./stripe.service";
import { ScheduledPriceChangeService } from "./scheduled-price-change";
import { AutoLockSwitchService } from "./auto-lock-switch.service";
import { autoLockAllowed, recordAutoLockSkip } from "./auto-lock-gate";
import { expiredTrialWhere, scheduledCancellationWhere } from "./auto-lock-candidates";
import { markNeedsReconcile } from "./needs-reconcile";
import { resolvePlanPrice } from "./plan-price";
import { CHECKOUT_ADDON_EXPAND, stripeAddonItemIds } from "./stripe-addon-items";
import { stripeBaseItem } from "./stripe-period";
import { lockTenantPrice } from "./price-lock";

/** A run of this many snapshot failures in one sweep is systemic — the sweep aborts loudly. */
const MAX_CONSECUTIVE_SNAPSHOT_FAILURES = 3;

/**
 * #2641 / SA-544: a scheduled downgrade whose tenant or schedule changed between the sweep's scan
 * and the Tenant row lock (suspended, deleted, schedule disarmed or retargeted). Thrown INSIDE the
 * transaction so the plan-transition snapshot rolls back with it; the per-row catch skips the
 * tenant (the row stays armed) without counting it toward the snapshot-failure breaker.
 */
class DowngradeOvertakenError extends Error {}

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
    private readonly billingNotification: BillingNotificationService,
    // Lane B A2b: a scheduled downgrade snapshots the tenant's feature config in the same tx.
    private readonly planTransition: PlanTransitionConfigService,
    // READ-ONLY (lead R1): verifies the price Stripe bills after a downgrade flips. This sweep never pushes one.
    private readonly stripe: StripeService,
    // R1 option B: the backup sweep for a downgrade price whose `invoice.upcoming` webhook was missed.
    private readonly scheduledPrice: ScheduledPriceChangeService,
    // SA-775: the rollout pause on AUTOMATIC locks (trial expiry, scheduled cancellation). @Optional only so a
    // unit spec can build the sweep bare; billing.module-wiring.spec.ts pins that production injects it.
    @Optional() private readonly autoLocks?: AutoLockSwitchService,
  ) {}

  private planMonthly(version: PlanVersionWithCatalog | null, planKey: string | null): number {
    if (!version || !planKey) return 0;
    const d = findPlanDefinition(version.definitions, planKey);
    return d?.monthlyPrice != null ? Number(d.monthlyPrice) : 0;
  }

  /**
   * CHANGE-2 (2026-09-13): true only for `planKeyToEnum()`'s dedicated `UnknownPlanKeyError`
   * (`plan-catalog.constants.ts`) — the ONLY failure `applyScheduledDowngrades`' per-tenant
   * catch below may still log-and-skip. Was a message-PREFIX match on a plain `Error` (F2,
   * W1 review-fix round) — brittle, because a reworded message would have silently stopped
   * matching and started swallowing a real infrastructure failure as a data problem. Now an
   * `instanceof` check against the typed class instead. Everything else — a pool exhaustion,
   * a Prisma error, any other unrelated failure — must NOT match here, so the caller rethrows
   * it instead of disguising a real infrastructure failure as a bad plan key (the sweep would
   * otherwise silently report success while masking one).
   */
  private isUnresolvablePlanKeyError(err: unknown): boolean {
    return err instanceof UnknownPlanKeyError || err instanceof PlanNotInCatalogError;
  }

  /** Trial expiry → READ_ONLY (NOT suspended — exports + sign-in still work). */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.expireTrials")
  async expireTrials(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.tenant.findMany({
      where: expiredTrialWhere(now),
      select: { id: true, trialEndsAt: true, class: true },
    });
    let locked = 0;
    let held = 0;
    for (const t of expired) {
      // SA-775 (row 381): the rollout pause. While the switch is paused a PRODUCTION trial is NOT locked: no
      // status write, no notice. ONE durable skip record per trialEndsAt; the hourly pass meeting it again writes
      // nothing, and the pass after an unpause finds the case again (it is still TRIAL and past its end).
      if (!(await autoLockAllowed(this.autoLocks, t, "trial_expired"))) {
        await recordAutoLockSkip(
          this.prisma,
          {
            tenantId: t.id,
            kind: "trial_expired",
            key: (t.trialEndsAt as Date).toISOString(),
            wouldHaveSet: { status: "READ_ONLY", readOnlyReason: "trial_expired" },
          },
          this.logger,
        );
        held++;
        continue;
      }
      // Compare-and-swap (SA-774r5 MF9): only a tenant that is STILL on TRIAL is locked and announced, so a
      // concurrent activation or a repeated pass writes nothing and emits nothing. The class the gate judged is part of
      // the CAS (SA-775 S3): a TEST->PRODUCTION reclassification between the scan and this write cannot lock.
      const { count } = await this.prisma.tenant.updateMany({
        where: { id: t.id, status: "TRIAL", class: t.class },
        data: { status: "READ_ONLY", readOnlyReason: "trial_expired" },
      });
      if (count !== 1) continue;
      locked++;
      await this.events.emit(t.id, BILLING_EVENTS.TRIAL_EXPIRED, { at: now.toISOString() });
      this.entitlements.invalidate(t.id);
      this.tenantStatus.invalidate(t.id);
      // N3: best-effort admin notification, never blocks the expiry transition above.
      try {
        await this.billingNotification.notifyTrialEnding(
          t.id,
          "TRIAL_ENDING_EXPIRY",
          t.trialEndsAt as Date,
        );
      } catch (e) {
        this.logger.error(
          `N3 notifyTrialEnding(EXPIRY) threw unexpectedly for tenant ${t.id}`,
          e as Error,
        );
      }
    }
    if (locked) this.logger.log(`Expired ${locked} trials → READ_ONLY`);
    if (held) this.logger.log(`Held ${held} expired trials: automatic locks are paused`);
  }

  /**
   * N3: trial-ending reminders at 7 days and 1 day before `trialEndsAt`. Runs hourly, same
   * as expireTrials — each window is ~24h wide (not a point-in-time match), so a tenant is
   * seen multiple times within it; BillingNotificationService's own (tenant, milestone)
   * idempotency claim is what actually caps each milestone to exactly one send.
   */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.warnTrialsEnding")
  async warnTrialsEnding(): Promise<void> {
    const now = new Date();
    const DAY_MS = 24 * 60 * 60 * 1000;
    const in6d = new Date(now.getTime() + 6 * DAY_MS);
    const in7d = new Date(now.getTime() + 7 * DAY_MS);
    const in1d = new Date(now.getTime() + DAY_MS);

    const sevenDayWindow = await this.prisma.tenant.findMany({
      where: { status: "TRIAL", trialEndsAt: { gte: in6d, lt: in7d }, deletedAt: null },
      select: { id: true, trialEndsAt: true },
    });
    for (const t of sevenDayWindow) {
      try {
        await this.billingNotification.notifyTrialEnding(
          t.id,
          "TRIAL_ENDING_7D",
          t.trialEndsAt as Date,
        );
      } catch (e) {
        this.logger.error(
          `N3 notifyTrialEnding(7D) threw unexpectedly for tenant ${t.id}`,
          e as Error,
        );
      }
    }

    const oneDayWindow = await this.prisma.tenant.findMany({
      where: { status: "TRIAL", trialEndsAt: { gte: now, lt: in1d }, deletedAt: null },
      select: { id: true, trialEndsAt: true },
    });
    for (const t of oneDayWindow) {
      try {
        await this.billingNotification.notifyTrialEnding(
          t.id,
          "TRIAL_ENDING_1D",
          t.trialEndsAt as Date,
        );
      } catch (e) {
        this.logger.error(
          `N3 notifyTrialEnding(1D) threw unexpectedly for tenant ${t.id}`,
          e as Error,
        );
      }
    }
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
    const snapshotOn = await this.planTransition.isEnabled();
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
        // #2223 / SA-444c: the negotiated fee a downgrade keeps.
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        stripeSubId: true,
        // #2460 / SA-464 (2): the ledger nets against the stored snapshot, never the catalog.
        basePriceSnapshot: true,
        downgradeToPlanKey: true,
        downgradeEffectiveAt: true,
        retainedUserIds: true,
        // `planKey` is nullable (the pre-plans-as-data cohort): resolve the plan being LEFT the
        // way every other plan path does, or the snapshot would be skipped for exactly those tenants.
        // Joined ONLY while the snapshot flag is on — flag off, the query is exactly what it was.
        ...(snapshotOn ? { tenant: { select: { plan: true } } } : {}),
      },
    });
    let applied = 0;
    let overtaken = 0;
    let consecutiveSnapshotFailures = 0;
    for (const s of subs) {
      const target = s.downgradeToPlanKey as string;
      // Price the MRR delta + caps from the tenant's PINNED version (grandfathering),
      // not the published one. Skip loudly if the catalog can't be resolved.
      let fromVersion: PlanVersionWithCatalog;
      try {
        fromVersion = await this.catalog.getVersionForTenant(s.planVersionId);
      } catch {
        this.logger.error(`Skipping downgrade for ${s.tenantId} — catalog unresolvable`);
        continue;
      }

      // SA-733 D8: the same per-tenant lock the upgrade and the price override take, so this push and its
      // possible revert cannot interleave with another price writer. Held until the finally below.
      let unlock: () => Promise<void>;
      try {
        unlock = await lockTenantPrice(s.tenantId);
      } catch (lockErr) {
        this.logger.error(
          `Scheduled downgrade held back for tenant=${s.tenantId} — ${(lockErr as Error).message}; still armed, next sweep retries`,
        );
        continue;
      }
      try {
        // SA-733 D8: everything below is built from THIS read, taken UNDER the lock. The scan above ran before
        // the lock, so a fee an admin committed in between would otherwise be overwritten by the stale one in
        // Stripe AND on the MRR snapshot. The schedule and the tenant are re-proved here too.
        const cur = await this.prisma.tenantSubscription.findUnique({
          where: { tenantId: s.tenantId },
          select: {
            planKey: true,
            priceOverrideMonthly: true,
            priceOverrideAnnual: true,
            stripeSubId: true,
            basePriceSnapshot: true,
            downgradeToPlanKey: true,
            downgradeEffectiveAt: true,
            retainedUserIds: true,
            tenant: { select: { status: true, deletedAt: true } },
          },
        });
        if (
          !cur ||
          cur.tenant?.status !== "ACTIVE" ||
          cur.tenant.deletedAt != null ||
          cur.planKey !== s.planKey ||
          cur.downgradeToPlanKey !== target ||
          cur.downgradeEffectiveAt == null ||
          cur.downgradeEffectiveAt > now
        ) {
          throw new DowngradeOvertakenError();
        }
        let targetVersion = fromVersion;
        let targetDef = findPlanDefinition(fromVersion.definitions, target);
        if (!targetDef) {
          // The tenant's pinned (grandfathered) version predates this plan (e.g. LITE shipped
          // in v12) — resolve the target against the currently published catalog instead of
          // silently pricing it as $0 and falling back to STARTER entitlements.
          const published = await this.catalog.getPublishedVersion();
          targetDef = published ? findPlanDefinition(published.definitions, target) : undefined;
          if (!published || !targetDef) {
            throw new PlanNotInCatalogError(
              target,
              [fromVersion.id, published?.id].filter((x): x is string => Boolean(x)),
            );
          }
          targetVersion = published;
        }
        // #2223 / SA-444c (i) + #2460 / SA-464 (2), one invariant (snapshot = what the tenant pays):
        // the new snapshot is the negotiated fee, else the target's price; the ledger books it minus
        // what the MRR snapshot counted (the stored snapshot, NULL ⇒ 0) — never a catalog price for
        // the plan being left. A consistent override row therefore books Δ0.
        const override = priceOverrideOf(cur);
        const newBase = override ?? this.planMonthly(targetVersion, target);
        const seatCap = targetDef.seatsIncluded ?? null;

        const tenantPlan = (s as { tenant?: { plan?: string } }).tenant?.plan;
        const transition = snapshotOn
          ? {
              tenantId: s.tenantId,
              fromPlanKey: normalizePlanKey(s.planKey) ?? planKeyFromEnum(tenantPlan),
              toPlanKey: target,
              toPlanVersionId: targetVersion.id,
              actor: { id: null, name: "system: scheduled downgrade" },
            }
          : null;
        const preparedTransition = transition
          ? await this.planTransition.prepare(transition)
          : null;

        // This 02:00 flip NEVER pushes a price to Stripe (lead ruling R1): it is date-driven and can run AFTER
        // Stripe cut the renewal invoice at the old price. The price reaches Stripe BEFORE the renewal, from
        // scheduled-price-change.ts, before the renewal invoice (R1 Option B: the `invoice.upcoming` webhook + the hourly backup below). Here the local
        // row flips, and Stripe is only VERIFIED (read-only) once the flip has committed.
        const written = this.prisma.$transaction(async (tx) => {
          // Snapshot first, in the same transaction: a failure here throws into the per-row catch
          // below, so THIS tenant's downgrade is not applied (fail closed) and retries next tick.
          if (transition && preparedTransition) {
            await this.planTransition.onPlanChange(tx, transition, preparedTransition);
          }
          // #2551 / SA-503a: the house order — Tenant row lock right after the hook, before the
          // subscription write (reconcile/updatePlan/Pricing hold Tenant, then write this row).
          await lockTenantForLedger(tx, s.tenantId);
          // #2641 / SA-544: the scan's filter is re-proved on the rows read UNDER that lock — a
          // tenant suspended/deleted, or a schedule disarmed/retargeted, since the scan is skipped
          // (not applied at Δ0). "Paying" on both sides is the shared isPayingRow, and Δ nets
          // against the LOCKED snapshot; a non-PRODUCTION class still applies, booking Δ0.
          const lockedTenant = await tx.tenant.findUnique({
            where: { id: s.tenantId },
            select: { status: true, class: true, deletedAt: true },
          });
          const lockedSub = await tx.tenantSubscription.findUnique({
            where: { tenantId: s.tenantId },
            select: {
              planKey: true,
              basePriceSnapshot: true,
              priceOverrideMonthly: true,
              priceOverrideAnnual: true,
              stripeSubId: true,
              downgradeToPlanKey: true,
              downgradeEffectiveAt: true,
              couponFull: true,
            },
          });
          if (
            !lockedTenant ||
            lockedTenant.status !== "ACTIVE" ||
            lockedTenant.deletedAt != null ||
            !lockedSub ||
            lockedSub.planKey !== s.planKey ||
            // The fee and the Stripe subscription Stripe was priced from must still be the committed ones.
            !sameOverride(lockedSub, cur) ||
            lockedSub.stripeSubId !== cur.stripeSubId ||
            lockedSub.downgradeToPlanKey !== target ||
            lockedSub.downgradeEffectiveAt == null ||
            lockedSub.downgradeEffectiveAt > now
          ) {
            throw new DowngradeOvertakenError();
          }
          const amountDelta = roundMoney(
            (isPayingRow(lockedTenant, target, lockedSub.couponFull) ? newBase : 0) -
              (isPayingRow(lockedTenant, lockedSub.planKey, lockedSub.couponFull)
                ? Number(lockedSub.basePriceSnapshot ?? 0)
                : 0),
          );
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
              planVersionId: targetVersion.id,
              basePriceSnapshot: override ?? targetDef.monthlyPrice ?? null,
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
                  id: { notIn: cur.retainedUserIds },
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
        }, this.planTransition.transactionOptions(preparedTransition));
        await written;
        this.planTransition.invalidateCaches(s.tenantId, preparedTransition);
        await this.verifyStripeBillsDowngrade(
          s.tenantId,
          cur.stripeSubId,
          targetDef,
          { monthly: cur.priceOverrideMonthly, annual: cur.priceOverrideAnnual },
          target,
        );

        // N3: best-effort admin notification, never blocks the transaction above. `key` is
        // the effective date this tenant's row carried before the transaction cleared it —
        // `s.downgradeEffectiveAt`, captured before this loop iteration started, so a re-run
        // of this cron tick dedupes correctly even though the row no longer shows a pending
        // downgrade after this point.
        try {
          const fromDefApplied = findPlanDefinition(fromVersion.definitions, s.planKey);
          await this.billingNotification.notifyDowngradeApplied(
            s.tenantId,
            fromDefApplied?.name ?? s.planKey ?? "your previous plan",
            targetDef.name,
            s.downgradeEffectiveAt as Date,
          );
        } catch (e) {
          this.logger.error(
            `N3 notifyDowngradeApplied threw unexpectedly for tenant ${s.tenantId}`,
            e as Error,
          );
        }
      } catch (err) {
        // #2641 / SA-544: overtaken since the scan — skipped, still armed, never a breaker count.
        if (err instanceof DowngradeOvertakenError) {
          overtaken++;
          continue;
        }
        // F2: narrowed from "catch everything" — only planKeyToEnum()'s own unresolvable-key
        // Error is a data problem this sweep may skip past. Anything else (pool exhaustion, a
        // Prisma error, any other unrelated failure) rethrows so it surfaces as a real cron
        // failure instead of being logged and swallowed as if it were a bad plan key.
        // A snapshot that could not be written fails THIS tenant's downgrade closed (the tx rolled
        // back, the schedule stays armed, next tick retries) — but must not strand every tenant
        // after it in this sweep, so it is logged loudly and the loop carries on.
        if (err instanceof SnapshotFailedError) {
          this.logger.error(`Scheduled downgrade held back — ${err.message}`);
          // Several in a row is not one bad tenant but a systemic fault (pool exhausted, DB down):
          // surface it as the cron failure it is instead of "succeeding" having applied nothing.
          if (++consecutiveSnapshotFailures >= MAX_CONSECUTIVE_SNAPSHOT_FAILURES) throw err;
          continue;
        }
        if (!this.isUnresolvablePlanKeyError(err)) throw err;
        // B218: log and move on — a cron that dies on tenant N's bad row would silently
        // strand every tenant after it unapplied too, which is worse than the one bad row.
        this.logger.error(
          `Skipping scheduled downgrade for tenant=${s.tenantId} target="${target}" — ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        continue;
      } finally {
        await unlock();
      }
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
      consecutiveSnapshotFailures = 0;
      applied++;
    }
    if (applied) this.logger.log(`Applied ${applied} scheduled downgrades`);
    if (overtaken) {
      this.logger.log(`Skipped ${overtaken} scheduled downgrades changed since the scan`);
    }
  }

  /**
   * Backup for the `invoice.upcoming` webhook (lead R1, option B): push the scheduled downgrade's price to Stripe
   * for every tenant whose period ends within 48 h and whose price Stripe does not already bill. NEVER after the
   * period end (those tenants are not candidates), idempotent, one tenant at a time under the tenant-price lock.
   * The 02:00 flip above stays date-driven and local; THIS is what makes the renewal invoice use the new price.
   */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.pushUpcomingDowngradePrices")
  async pushUpcomingDowngradePrices(): Promise<void> {
    const { pushed, held } = await this.scheduledPrice.applyDue();
    if (pushed || held) {
      this.logger.log(`Scheduled downgrade prices: pushed ${pushed}, held back ${held}`);
    }
  }

  /**
   * READ-ONLY check, after a downgrade's local flip committed: does Stripe's base item bill the downgraded
   * monthly price? A mismatch means the tenant is still billed the old plan (the pre-renewal push from
   * scheduled-price-change.ts that should have prevented it did not happen), so it is ALERTED (`markNeedsReconcile`), never fixed here. Best-effort:
   * a Stripe read failure is logged and never fails the sweep; annual items are not compared.
   *
   * L-167, one rule: the expected price is `resolvePlanPrice` and the add-on item set is
   * `stripeAddonItemIds` - the very two the push (`ScheduledPriceChangeService.apply`) uses - so the push and its
   * verification can never disagree about what Stripe should bill or which item is the base.
   */
  private async verifyStripeBillsDowngrade(
    tenantId: string,
    stripeSubId: string | null | undefined,
    targetDef: { monthlyPrice?: unknown; annualPrice?: unknown } | null | undefined,
    override: { monthly?: unknown; annual?: unknown },
    target: string,
  ): Promise<void> {
    if (!stripeSubId || !this.stripe?.isConfigured) return;
    const price = resolvePlanPrice(targetDef, override);
    if (!price.ok) return;
    const expectedMonthly = price.monthly;
    try {
      const sub = await this.stripe.getSubscription(stripeSubId, {
        expand: CHECKOUT_ADDON_EXPAND,
      });
      const ids = await stripeAddonItemIds(this.prisma, tenantId, sub);
      const base = stripeBaseItem(sub, ids);
      if (!base || ids.has(base.id) || base.price?.recurring?.interval !== "month") return;
      const expectedCents = toCents(expectedMonthly);
      if (base.price?.unit_amount === expectedCents) return;
      await markNeedsReconcile(
        { prisma: this.prisma, logger: this.logger },
        {
          tenantId,
          stripeSubId,
          local: { planKey: target, monthly: Number(expectedMonthly) },
          stripe: { billedCents: base.price?.unit_amount ?? null, expectedCents },
          error: "the downgrade flipped locally but Stripe still bills a different price",
        },
      );
    } catch (e) {
      this.logger.warn(
        `Could not verify Stripe's price after the downgrade of tenant=${tenantId}: ${(e as Error).message}`,
      );
    }
  }

  /** End access for self-cancelled subscriptions whose period has ended → READ_ONLY
   *  (data intact, exports + sign-in + re-subscribe still work). */
  @LeaderCron(CronExpression.EVERY_HOUR, "billing-cron.applyScheduledCancellations")
  async applyScheduledCancellations(): Promise<void> {
    const now = new Date();
    const subs = await this.prisma.tenantSubscription.findMany({
      where: scheduledCancellationWhere(now),
      select: { tenantId: true },
    });
    let applied = 0;
    let held = 0;
    for (const s of subs) {
      // #2641 / SA-544: ONE transaction per tenant, Tenant row lock FIRST; the scan's filter is
      // re-proved on the rows read under it (suspended/deleted, cancellation resumed, or period
      // moved since the scan ⇒ no-op). Everything below is priced from those LOCKED rows.
      const done = await this.prisma.$transaction(async (tx) => {
        await lockTenantForLedger(tx, s.tenantId);
        const tenant = await tx.tenant.findUnique({
          where: { id: s.tenantId },
          select: { status: true, class: true, deletedAt: true },
        });
        const sub = await tx.tenantSubscription.findUnique({
          where: { tenantId: s.tenantId },
          select: {
            planKey: true,
            basePriceSnapshot: true,
            discount: true,
            cancelAtPeriodEnd: true,
            periodEnd: true,
            couponFull: true,
          },
        });
        if (
          !tenant ||
          tenant.status !== "ACTIVE" ||
          tenant.deletedAt != null ||
          !sub?.cancelAtPeriodEnd ||
          sub.periodEnd == null ||
          sub.periodEnd >= now
        ) {
          return false;
        }
        // SA-775 (row 381): the rollout pause. A PRODUCTION tenant is NOT locked while the switch is paused: no
        // READ_ONLY, its add-ons stay active, no churn event, and cancelAtPeriodEnd stays armed so the pass after
        // an unpause finds it again. The skip record is written after this transaction (one per periodEnd).
        if (
          !(await autoLockAllowed(
            this.autoLocks,
            { id: s.tenantId, class: tenant.class },
            "subscription_cancelled",
          ))
        ) {
          return { heldPeriodEnd: sub.periodEnd };
        }
        // The run-rate this tenant stops contributing once access ends → emit it as a NEGATIVE
        // MRR delta (base + active add-ons − discount) so the append-only ledger nets down with
        // churn instead of over-counting the tenant's last plan forever. Booked only for a row in
        // the shared paying set (isPayingRow) — any other class was never counted, so Δ0.
        // N4: only BILLABLE add-ons were ever in the run-rate (a comp is a platform grant, never booked).
        const addons = await tx.tenantAddon.findMany({
          where: billableAddonWhere({ tenantId: s.tenantId, active: true }),
          select: { priceSnapshot: true, quantity: true },
        });
        const addonMrr = addons.reduce(
          (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
          0,
        );
        const contribution = isPayingRow(tenant, sub.planKey ?? null, sub.couponFull)
          ? roundMoney(
              (sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0) +
                addonMrr -
                Number(sub.discount ?? 0),
            )
          : 0;
        await tx.tenant.update({
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
        await tx.tenantAddon.updateMany({
          where: { tenantId: s.tenantId, active: true },
          data: { active: false },
        });
        await this.events.emit(
          s.tenantId,
          BILLING_EVENTS.SUBSCRIPTION_CANCELED,
          { appliedAt: now.toISOString() },
          { amountDelta: contribution ? -contribution : 0, tx },
        );
        return true;
      });
      if (done && typeof done === "object") {
        await recordAutoLockSkip(
          this.prisma,
          {
            tenantId: s.tenantId,
            kind: "subscription_cancelled",
            key: done.heldPeriodEnd.toISOString(),
            wouldHaveSet: { status: "READ_ONLY", readOnlyReason: "subscription_cancelled" },
          },
          this.logger,
        );
        held++;
        continue;
      }
      if (!done) continue;
      // After commit: caches never observe a rolled-back transition.
      this.entitlements.invalidate(s.tenantId);
      this.tenantStatus.invalidate(s.tenantId);
      applied++;
    }
    if (applied) this.logger.log(`Applied ${applied} scheduled cancellations → READ_ONLY`);
    if (held) this.logger.log(`Held ${held} scheduled cancellations: automatic locks are paused`);
    if (subs.length > applied + held) {
      this.logger.log(
        `Skipped ${subs.length - applied - held} scheduled cancellations changed since the scan`,
      );
    }
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
      select: {
        tenantId: true,
        cycle: true,
        periodStart: true,
        periodEnd: true,
        externalPayment: true,
      },
    });
    for (const s of subs) {
      const start = s.periodEnd as Date;
      // SA-744r2: an external (manual-pay) row rolls onto the owner's CALENDAR - the same helper the RF
      // invoice issuer uses for "the next window" (L-167), so the two always agree - and BOTH ends are
      // written (the snapped start, never the raw old end). Stripe/catalog rows keep addCycle's calendar
      // clamping (B329 note above).
      let next: { periodStart: Date; periodEnd: Date };
      if (s.externalPayment) {
        next = nextBillingWindow(start, effectiveCycle(s.cycle, s.periodStart, start));
      } else {
        next = { periodStart: start, periodEnd: addCycle(start, s.cycle) };
      }
      await this.prisma.tenantSubscription.update({
        where: { tenantId: s.tenantId },
        data: { periodStart: next.periodStart, periodEnd: next.periodEnd },
      });
    }
    if (subs.length) this.logger.log(`Rolled ${subs.length} billing cycles`);
  }
}
