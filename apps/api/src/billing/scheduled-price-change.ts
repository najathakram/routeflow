import { randomUUID } from "crypto";
import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from "@nestjs/common";
import { toCents } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { PrismaService } from "../prisma/prisma.service";
import { findPlanDefinition } from "./plan-catalog.constants";
import { PlanCatalogService } from "./plan-catalog.service";
import { markNeedsReconcile } from "./needs-reconcile";
import { PLAN_CHANGE_BILLING_FAILED, type PlanChangeAudience } from "./plan-change-stripe";
import { resolvePlanPrice } from "./plan-price";
import { underTenantPriceLock } from "./price-lock";
import { CHECKOUT_ADDON_EXPAND, stripeAddonItemIds } from "./stripe-addon-items";
import {
  isLiveStripeSubscriptionStatus,
  isTerminalStripeSubscriptionStatus,
  stripeBaseItem,
  stripeSubscriptionPeriod,
} from "./stripe-period";
import { StripeService } from "./stripe.service";

/**
 * SA-733 D8, lead ruling R1 (option B): a scheduled downgrade reaches Stripe BEFORE the renewal invoice is cut,
 * never after it. The 02:00 local flip (billing-cron `applyScheduledDowngrades`) is a date-driven local write
 * and may run after Stripe has already invoiced the renewal at the old price, so it never pushes a price. The
 * push lives HERE, in ONE function, with two triggers:
 *   1. the Stripe `invoice.upcoming` webhook (days before the renewal), through the existing idempotent
 *      StripeBillingEvent ledger; and
 *   2. an hourly backup sweep ({@link ScheduledPriceChangeService.applyDue}) for a downgrade whose period ends
 *      within 48 h - a missed or undelivered webhook - and NEVER after the period has ended.
 *
 * Runs under the `tenant-price` lock (the single price-lock.ts module), re-reads the subscription under it, and
 * pushes the scheduled target's resolved price (a custom fee beats the plan price) onto the base item with
 * proration `none` (the lower price starts with the renewal; no credit mid-period).
 *
 * THE "APPLIED" MARKER IS STRIPE ITSELF: the schedule is applied exactly when the base item already bills the
 * target amount. No column is needed (this PR has no schema change) and it is immune to a lost write: a replay,
 * a second trigger and a concurrent call all see equality and do nothing, and a custom-fee tenant whose price
 * does not change needs no push at all. The Stripe idempotency key ((stripeSubId, downgradeEffectiveAt, target
 * version)) additionally collapses a retry of the same push.
 *
 * MONTHLY single-interval items only: an annual or `interval_count` ≠ 1 item is REFUSED with a coded error (its
 * target price and proration are not specified), never silently skipped.
 */

/** The backup sweep covers a downgrade whose period ends within this window. */
/** N4: what a TENANT is told when the scheduled downgrade's price cannot be checked before its own change. */
export const SCHEDULED_PRICE_TENANT_REFUSED =
  "We couldn't change your plan right now. Nothing was changed. Please try again later or contact support.";

export const SCHEDULED_PRICE_LEAD_MS = 48 * 60 * 60 * 1000;

export type ScheduledPriceOutcome =
  | { applied: true; amountCents: number; priorAmountCents: number; key: string }
  | { applied: false; reason: string };

@Injectable()
export class ScheduledPriceChangeService {
  private readonly logger = new Logger(ScheduledPriceChangeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly catalog: PlanCatalogService,
  ) {}

  /**
   * Push this tenant's scheduled downgrade price to Stripe, once. A no-op (never an error) for a tenant with no
   * Stripe subscription, no scheduled downgrade, a period that has ended, or a price Stripe already bills.
   * THROWS (coded) for: an annual / multi-interval item, an unresolvable price, an unreadable or non-live
   * Stripe subscription, or a lock that could not be taken - in every case nothing was sent.
   */
  apply(tenantId: string, now: Date = new Date()): Promise<ScheduledPriceOutcome> {
    return underTenantPriceLock(tenantId, () => this.applyLocked(tenantId, now));
  }

  /** The tenants whose scheduled downgrade is due for the backup sweep: Stripe-billed, period ends within 48 h. */
  async dueTenantIds(now: Date = new Date()): Promise<string[]> {
    const rows = await this.prisma.tenantSubscription.findMany({
      where: {
        stripeSubId: { not: null },
        downgradeToPlanKey: { not: null },
        // After the period end there is nothing left to do (the invoice is cut): never a candidate.
        downgradeEffectiveAt: { gt: now, lte: new Date(now.getTime() + SCHEDULED_PRICE_LEAD_MS) },
        tenant: { status: "ACTIVE", deletedAt: null },
      },
      select: { tenantId: true },
      orderBy: { downgradeEffectiveAt: "asc" },
    });
    return rows.map((r) => r.tenantId);
  }

  /**
   * The backup sweep body: apply every due tenant. One tenant that cannot be pushed (a lock collision, an
   * unreadable Stripe, an unsupported interval) is logged and never stops the rest; it is retried next tick.
   */
  async applyDue(now: Date = new Date()): Promise<{ pushed: number; held: number }> {
    let pushed = 0;
    let held = 0;
    for (const tenantId of await this.dueTenantIds(now)) {
      try {
        const out = await this.apply(tenantId, now);
        if (out.applied) pushed++;
      } catch (err) {
        held++;
        this.logger.error(
          `Scheduled price change held back for tenant=${tenantId}: ${(err as Error).message}`,
        );
      }
    }
    return { pushed, held };
  }

  /**
   * Has this tenant's scheduled downgrade price ALREADY been pushed onto its Stripe base item? True only when
   * the live monthly base item bills exactly the downgrade target's price (and that differs from the price of
   * the plan the tenant is on). The plan-price fan-out uses it, under the tenant-price lock, to leave ONLY such
   * tenants alone: syncing them would price Stripe from the plan they are leaving and revert the push. A tenant
   * whose downgrade is scheduled but NOT yet pushed must still be synced: its Stripe item bills the plan's old
   * price, and the catalog edit has to reach it (the later push, if the downgrade stands, overwrites it; if the
   * downgrade is cancelled it simply stays correct). Anything unreadable answers true - never revert blind.
   */
  async isDowngradePricePushed(tenantId: string): Promise<boolean> {
    try {
      const sub = await this.prisma.tenantSubscription.findUnique({
        where: { tenantId },
        select: {
          planKey: true,
          planVersionId: true,
          stripeSubId: true,
          priceOverrideMonthly: true,
          priceOverrideAnnual: true,
          downgradeToPlanKey: true,
        },
      });
      if (
        !sub?.stripeSubId ||
        !sub.downgradeToPlanKey ||
        !sub.planKey ||
        !this.stripe.isConfigured
      ) {
        return false;
      }
      const version = await this.catalog.getVersionForTenant(sub.planVersionId);
      const override = { monthly: sub.priceOverrideMonthly, annual: sub.priceOverrideAnnual };
      const kept = resolvePlanPrice(findPlanDefinition(version.definitions, sub.planKey), override);
      let targetDef = findPlanDefinition(version.definitions, sub.downgradeToPlanKey);
      if (!targetDef) {
        const published = await this.catalog.getPublishedVersion();
        targetDef = published
          ? findPlanDefinition(published.definitions, sub.downgradeToPlanKey)
          : undefined;
      }
      const target = resolvePlanPrice(targetDef, override);
      if (!kept.ok || !target.ok) return true;
      const targetCents = toCents(target.monthly);
      if (targetCents === toCents(kept.monthly)) return false; // a custom fee: no lower price was pushed

      const stripeSub = await this.stripe.getSubscription(sub.stripeSubId, {
        expand: CHECKOUT_ADDON_EXPAND,
      });
      if (!isLiveStripeSubscriptionStatus(stripeSub?.status)) return false;
      const ids = await stripeAddonItemIds(this.prisma, tenantId, stripeSub);
      const base = stripeBaseItem(stripeSub, ids);
      const recurring = base?.price?.recurring;
      if (!base || ids.has(base.id) || recurring?.interval !== "month") return false;
      return base.price?.unit_amount === targetCents;
    } catch {
      return true;
    }
  }

  /**
   * The undo of {@link apply}: the tenant kept its plan (`resume()` = "Keep current plan") AFTER the lower price
   * had already been pushed for the renewal. If Stripe's base item still bills exactly the cleared target's price
   * (and the row now carries no schedule), put it back on the price of the plan the tenant is staying on - proration
   * `none`, so the renewal bills the plan they kept. Anything else (Stripe was never pushed, or something else
   * moved the price) is left alone. Under the same tenant-price lock, re-reading the row. Best-effort for the
   * caller (resume() has already committed): a failure is logged and ALERTED, never thrown to the tenant.
   */
  async restoreAfterScheduleCleared(tenantId: string, clearedTargetPlanKey: string): Promise<void> {
    try {
      await underTenantPriceLock(tenantId, () =>
        this.restoreIfPushedLocked(tenantId, clearedTargetPlanKey, { mustBeCleared: true }),
      );
    } catch (err) {
      await markNeedsReconcile(
        { prisma: this.prisma, logger: this.logger },
        {
          tenantId,
          local: { clearedTargetPlanKey },
          error: err,
        },
      );
    }
  }

  /**
   * The same undo, for a caller that ALREADY holds the tenant-price lock and is about to disarm the schedule
   * itself (an upgrade or an admin plan edit while a downgrade is scheduled). It runs BEFORE that caller reads or
   * prorates Stripe's price: an early pre-renewal push left the base item on the LOWER price, and an upgrade
   * prorated from it would overcharge (old - lowered) x the remaining period. `mustBeCleared: false` because the
   * row still carries the schedule at this point. THROWS on any Stripe failure: the caller must not go on.
   */
  async restoreIfPushedLocked(
    tenantId: string,
    scheduledTargetPlanKey: string,
    opts: { mustBeCleared: boolean; audience?: PlanChangeAudience },
  ): Promise<void> {
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        planKey: true,
        planVersionId: true,
        stripeSubId: true,
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        downgradeToPlanKey: true,
      },
    });
    // A re-scheduled downgrade will push its own target; nothing without a Stripe subscription or Stripe.
    if (!sub?.stripeSubId || !sub.planKey || !this.stripe.isConfigured) return;
    if (opts.mustBeCleared && sub.downgradeToPlanKey) return;
    const version = await this.catalog.getVersionForTenant(sub.planVersionId);
    const keptDef = findPlanDefinition(version.definitions, sub.planKey);
    // The same resolution as apply(): a grandfathered pin that predates the target prices it from the published
    // catalog.
    let clearedDef = findPlanDefinition(version.definitions, scheduledTargetPlanKey);
    if (!clearedDef) {
      const published = await this.catalog.getPublishedVersion();
      clearedDef = published
        ? findPlanDefinition(published.definitions, scheduledTargetPlanKey)
        : undefined;
    }
    const kept = resolvePlanPrice(keptDef, {
      monthly: sub.priceOverrideMonthly,
      annual: sub.priceOverrideAnnual,
    });
    const cleared = resolvePlanPrice(clearedDef, {
      monthly: sub.priceOverrideMonthly,
      annual: sub.priceOverrideAnnual,
    });
    if (!kept.ok || !cleared.ok) {
      // A caller that is about to PRORATE from Stripe's price (an upgrade, an admin edit) must not go on blind.
      if (!opts.mustBeCleared) {
        throw new BadRequestException({
          code: API_ERROR_CODES.SCHEDULED_PRICE_CHANGE_REFUSED,
          // N4: a TENANT (the upgrade) sees fixed copy; an admin keeps the operator detail.
          message:
            opts.audience === "admin"
              ? "The price of the scheduled downgrade cannot be resolved, so Stripe's current price cannot be " +
                "verified before this change. Resolve the plan's price first."
              : SCHEDULED_PRICE_TENANT_REFUSED,
        });
      }
      return;
    }
    const keptCents = toCents(kept.monthly);
    const clearedCents = toCents(cleared.monthly);
    if (keptCents === clearedCents) return; // a custom fee: the price never moved

    const stripeSub = await this.stripe.getSubscription(sub.stripeSubId, {
      expand: CHECKOUT_ADDON_EXPAND,
    });
    if (!isLiveStripeSubscriptionStatus(stripeSub?.status)) return;
    const addonIds = await stripeAddonItemIds(this.prisma, tenantId, stripeSub);
    const base = stripeBaseItem(stripeSub, addonIds);
    const recurring = base?.price?.recurring;
    if (
      !base ||
      addonIds.has(base.id) ||
      recurring?.interval !== "month" ||
      (recurring?.interval_count ?? 1) !== 1
    )
      return;
    // Only undo OUR push: Stripe bills exactly the cleared target and not already the kept plan.
    if (base.price?.unit_amount !== clearedCents) return;

    // A fresh key per restore: Stripe replays a repeated key for 24 h, which would swallow a SECOND legitimate
    // restore after another push. Replays are made harmless by the amount check above.
    const key = `${sub.stripeSubId}:scheduled-price-restore:${clearedCents}-${keptCents}:${Date.now()}`;
    const product = await this.stripe.client.products.create(
      { name: `RouteFlow ${keptDef?.name ?? sub.planKey}` },
      { idempotencyKey: `${key}:product` },
    );
    await this.stripe.updateSubscription(
      sub.stripeSubId,
      {
        items: [
          {
            id: base.id,
            price_data: {
              currency: typeof base.price?.currency === "string" ? base.price.currency : "usd",
              unit_amount: keptCents,
              recurring: { interval: "month" },
              product: product.id,
            },
          },
        ],
        proration_behavior: "none",
      },
      { idempotencyKey: key },
    );
    this.logger.log(
      `billing.scheduled_price.restore ${JSON.stringify({ tenantId, stripeSubId: sub.stripeSubId, idempotencyKey: key, fromCents: clearedCents, toCents: keptCents })}`,
    );
  }

  private async applyLocked(tenantId: string, now: Date): Promise<ScheduledPriceOutcome> {
    const noop = (reason: string): ScheduledPriceOutcome => ({ applied: false, reason });
    // Everything below is built from THIS read, taken under the lock.
    const sub = await this.prisma.tenantSubscription.findUnique({
      where: { tenantId },
      select: {
        planKey: true,
        planVersionId: true,
        stripeSubId: true,
        priceOverrideMonthly: true,
        priceOverrideAnnual: true,
        downgradeToPlanKey: true,
        downgradeEffectiveAt: true,
        tenant: { select: { status: true, deletedAt: true } },
      },
    });
    if (!sub?.stripeSubId) return noop("no_stripe_subscription");
    if (!sub.downgradeToPlanKey || !sub.downgradeEffectiveAt) return noop("no_scheduled_downgrade");
    if (sub.tenant?.status !== "ACTIVE" || sub.tenant.deletedAt != null)
      return noop("tenant_inactive");
    // NEVER after the period end: by then Stripe has cut (or is cutting) the renewal invoice.
    if (sub.downgradeEffectiveAt.getTime() <= now.getTime()) return noop("period_ended");
    if (!this.stripe.isConfigured) return noop("stripe_not_configured");

    const target = sub.downgradeToPlanKey;
    const fromVersion = await this.catalog.getVersionForTenant(sub.planVersionId);
    let version = fromVersion;
    let targetDef = findPlanDefinition(fromVersion.definitions, target);
    if (!targetDef) {
      // A grandfathered pin that predates the target plan: the published catalog prices it (as the flip does).
      const published = await this.catalog.getPublishedVersion();
      targetDef = published ? findPlanDefinition(published.definitions, target) : undefined;
      if (!published || !targetDef) return this.refuse(tenantId, "price_unresolvable", target);
      version = published;
    }
    const price = resolvePlanPrice(targetDef, {
      monthly: sub.priceOverrideMonthly,
      annual: sub.priceOverrideAnnual,
    });
    if (!price.ok) return this.refuse(tenantId, "price_unresolvable", target);

    let stripeSub: any;
    try {
      stripeSub = await this.stripe.getSubscription(sub.stripeSubId, {
        expand: CHECKOUT_ADDON_EXPAND,
      });
    } catch (err) {
      this.logger.error(
        `Scheduled price tenant ${tenantId}: Stripe read failed: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
    }
    if (isTerminalStripeSubscriptionStatus(stripeSub?.status))
      return noop(`subscription_${stripeSub?.status}`);
    if (!isLiveStripeSubscriptionStatus(stripeSub?.status))
      return noop(`subscription_${stripeSub?.status}`);

    const addonIds = await stripeAddonItemIds(this.prisma, tenantId, stripeSub);
    const base = stripeBaseItem(stripeSub, addonIds);
    if (!base || addonIds.has(base.id)) return this.refuse(tenantId, "no_base_item", target);

    // Stripe's own clock too: if the renewal is already behind us there is nothing to schedule.
    const period = stripeSubscriptionPeriod(stripeSub, addonIds);
    if (period && period.periodEnd.getTime() <= now.getTime()) return noop("period_ended");

    const recurring = base.price?.recurring;
    if (recurring?.interval !== "month" || (recurring?.interval_count ?? 1) !== 1) {
      throw new BadRequestException({
        code: API_ERROR_CODES.SCHEDULED_PRICE_CHANGE_REFUSED,
        message:
          "A scheduled downgrade price can only be applied to a monthly subscription " +
          `(this item bills every ${recurring?.interval_count ?? 1} ${recurring?.interval ?? "?"}). ` +
          "Change the price in Stripe by hand before the renewal.",
      });
    }
    const priorAmountCents = base.price?.unit_amount;
    if (!Number.isInteger(priorAmountCents))
      return this.refuse(tenantId, "unreadable_base_price", target);

    const amountCents = toCents(price.monthly);
    // The marker: Stripe already bills the target amount (a replay, a second trigger, a custom fee whose price
    // does not change). Nothing to send.
    if (priorAmountCents === amountCents) return noop("already_applied");

    // The key names the STATE it moves from and to: the (prior, new) amounts AND the item's current Price id. A
    // push, a restore and a re-push of the same schedule repeat the amounts but not the Price id (an inline
    // price_data mints a new Price every update), so Stripe never replays the first one's cached result.
    // A per-apply() NONCE ends the key: Stripe caches even a 5xx under a key for 24 h, so a key that repeats
    // ACROSS requests (the same state read again after a failed push) would replay the cached error and the
    // renewal would go out at the old price. The nonce is minted once here, so the in-attempt retry below
    // (lost response) still reuses the SAME key and is replayed, not applied twice.
    const nonce = randomUUID();
    const key = `${sub.stripeSubId}:scheduled-price:${sub.downgradeEffectiveAt.toISOString()}:${version.id}:${target}:${priorAmountCents}-${amountCents}:${base.price?.id ?? "-"}:${nonce}`;
    try {
      const product = await this.stripe.client.products.create(
        { name: `RouteFlow ${targetDef.name}` },
        { idempotencyKey: `${key}:product` },
      );
      this.logger.log(
        `billing.scheduled_price.push ${JSON.stringify({
          tenantId,
          stripeSubId: sub.stripeSubId,
          idempotencyKey: key,
          targetPlanKey: target,
          targetPlanVersionId: version.id,
          priorAmountCents,
          basePriceCents: amountCents,
          proration: "none",
          periodEnd: sub.downgradeEffectiveAt.toISOString(),
        })}`,
      );
      // ONE attempt = one key, computed above from the state read BEFORE this call. The params and the key are
      // built once and every send of THIS attempt reuses them verbatim - never recomputed from a later re-read.
      const params = {
        items: [
          {
            id: base.id,
            price_data: {
              currency: typeof base.price?.currency === "string" ? base.price.currency : "usd",
              unit_amount: amountCents,
              recurring: { interval: "month" as const },
              product: product.id,
            },
          },
        ],
        proration_behavior: "none" as const,
      };
      const send = () =>
        this.stripe.updateSubscription(sub.stripeSubId as string, params, { idempotencyKey: key });
      try {
        await send();
      } catch (first) {
        // A lost response is not a failed update: Stripe may have applied it. Re-read; if the item already bills
        // the target the attempt is done. Otherwise (or if Stripe cannot be read) retry ONCE under the SAME key:
        // if the first send landed, Stripe replays it (no second application); if not, this one applies it.
        this.logger.warn(
          `Scheduled price tenant ${tenantId}: the push reported a failure (${(first as Error).message}) - verifying, then retrying under the same key ${key}`,
        );
        const live = await this.stripe
          .getSubscription(sub.stripeSubId, { expand: CHECKOUT_ADDON_EXPAND })
          .catch(() => null);
        const liveBase = live ? stripeBaseItem(live, addonIds) : undefined;
        if (liveBase?.price?.unit_amount !== amountCents) await send();
      }
    } catch (err) {
      this.logger.error(
        `Scheduled price tenant ${tenantId}: Stripe push failed: ${(err as Error).message}`,
      );
      throw new ServiceUnavailableException(PLAN_CHANGE_BILLING_FAILED);
    }
    return { applied: true, amountCents, priorAmountCents: priorAmountCents as number, key };
  }

  private refuse(tenantId: string, reason: string, target: string): never {
    this.logger.error(
      `Scheduled price tenant ${tenantId}: cannot apply the downgrade to ${target} (${reason})`,
    );
    throw new BadRequestException({
      code: API_ERROR_CODES.SCHEDULED_PRICE_CHANGE_REFUSED,
      message: `The scheduled downgrade price cannot be applied (${reason}).`,
    });
  }
}
