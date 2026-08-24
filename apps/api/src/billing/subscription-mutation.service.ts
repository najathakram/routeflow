import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { TenantStatusGuard } from "../tenant/tenant-status.guard";
import { roundMoney } from "../common/pricing";
import { PlanCatalogService, PlanVersionWithCatalog } from "./plan-catalog.service";
import { ProrationService } from "./proration.service";
import { SubscriptionService } from "./subscription.service";
import { EntitlementsService } from "./entitlements.service";
import { BillingEventService } from "./billing-event.service";
import {
  BILLING_EVENTS,
  findPlanDefinition,
  planRank,
  planKeyToEnum,
  addonSkuCode,
  SELF_SERVICE_ADDON_SKUS,
} from "./plan-catalog.constants";
import { annualPrice, Cycle } from "./billing-math";

export interface SubscribeInput {
  planKey: string;
  cycle: Cycle;
  addons?: Array<{ sku: string; quantity?: number }>;
}

/** Add whole months (or a year) to a UTC date, clamping the day to the target month's length
 *  (Jan 31 + 1mo → Feb 28/29, never overflowing into March). */
function addMonthsUtc(from: Date, months: number): Date {
  const day = from.getUTCDate();
  const d = new Date(
    Date.UTC(
      from.getUTCFullYear(),
      from.getUTCMonth() + months,
      1,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
    ),
  );
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

function addCycle(from: Date, cycle: Cycle): Date {
  return addMonthsUtc(from, cycle === "ANNUAL" ? 12 : 1);
}

/** A SKU a TENANT_ADMIN may add or drop themselves. Everything else "ships dark" —
 *  platform-admin grants it (see SELF_SERVICE_ADDON_SKUS). */
function isSelfServiceAddon(sku: string): boolean {
  return (SELF_SERVICE_ADDON_SKUS as readonly string[]).includes(sku);
}

const ADMIN_ONLY_ADDON_MESSAGE =
  "This add-on is enabled by RouteFlow for your workspace — contact support";

/**
 * Subscription state MUTATIONS (Plans & Billing Phase 4). Owns the tenant's
 * entitlement state — plan, add-ons, cycle, schedule — and emits a BillingEvent for
 * every transition (the MRR source of truth). Every emitted `amountDelta` is a signed
 * CHANGE to the monthly run-rate, so the Phase-6 rollup = Σ amountDelta. State-write
 * and audit-emit are wrapped in ONE transaction (all-or-nothing). Upgrades apply
 * INSTANTLY (prorated); downgrades + cancels are SCHEDULED at period end (applied by
 * the Phase-5 cron); disabling an add-on keeps its row (history read-only, never deletes).
 *
 * Payment rails (Stripe card capture) are orthogonal (BillingService/StripeService);
 * this service owns the internal entitlement state.
 */
@Injectable()
export class SubscriptionMutationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly catalog: PlanCatalogService,
    private readonly proration: ProrationService,
    private readonly subscription: SubscriptionService,
    private readonly entitlements: EntitlementsService,
    private readonly events: BillingEventService,
    private readonly tenantStatus: TenantStatusGuard,
  ) {}

  private planMonthly(version: PlanVersionWithCatalog, planKey: string | null | undefined): number {
    if (!planKey) return 0;
    const d = findPlanDefinition(version.definitions, planKey);
    return d?.monthlyPrice != null ? Number(d.monthlyPrice) : 0;
  }

  /** Commit a subscription / convert a trial by picking a plan (+ optional add-ons). */
  async subscribe(tenantId: string, input: SubscribeInput, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === input.planKey);
    if (!def) throw new BadRequestException(`Unknown plan "${input.planKey}"`);
    if (def.isCustom) throw new BadRequestException("Enterprise is a custom plan — contact sales.");
    const quote = await this.proration.quote({
      planKey: input.planKey,
      cycle: input.cycle,
      addons: input.addons,
    });

    // Prior state — MRR is accounted as the CHANGE from this baseline.
    const [tenant, priorSub, priorAddons] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
      this.prisma.tenantSubscription.findUnique({ where: { tenantId }, select: { planKey: true } }),
      this.prisma.tenantAddon.findMany({ where: { tenantId, active: true } }),
    ]);
    if (!tenant) throw new NotFoundException("Tenant not found");
    const wasTrial = tenant.status === "TRIAL";
    const now = new Date();
    const periodEnd = addCycle(now, input.cycle);

    const skuByCode = new Map(version.addonSkus.map((s) => [s.sku, s]));
    const monthlyOf = (code: string) => {
      const m = skuByCode.get(code);
      return m ? Number(m.monthlyPrice) : 0;
    };

    // Reconcile desired (from input) against prior-active add-ons. This is the same
    // TENANT_ADMIN self-service surface as enableAddon(), so an admin-only ("ships dark")
    // SKU is a 403 here too — otherwise subscribe() is a back door around that gate.
    const desired = new Map<string, number>();
    for (const a of input.addons ?? []) {
      if (!skuByCode.has(a.sku)) continue;
      if (!isSelfServiceAddon(a.sku)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
      desired.set(a.sku, Math.max(1, Math.trunc(a.quantity ?? 1)));
    }
    const priorByCode = new Map<string, { id: string; qty: number }>();
    for (const row of priorAddons) {
      const code = addonSkuCode(row);
      if (code) priorByCode.set(code, { id: row.id, qty: row.quantity });
    }
    // Only self-service add-ons are the tenant's to drop: an admin-granted SKU the payload
    // is not even allowed to name must not be revoked by omitting it.
    const toDisable = [...priorByCode.keys()].filter(
      (c) => !desired.has(c) && isSelfServiceAddon(c),
    );

    // Coming from a NON-paying status (READ_ONLY / SUSPENDED / CANCELLED / TRIAL) the tenant
    // still carries its old planKey but contributes 0 to the run-rate — so re-entry is a full
    // +base delta, mirroring the negative delta emitted when access ended (billing-cron
    // applyScheduledCancellations). Only an already-ACTIVE tenant nets against its old plan.
    const oldPlanMonthly =
      tenant.status === "ACTIVE" ? this.planMonthly(version, priorSub?.planKey) : 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.upsert({
        where: { tenantId },
        create: {
          tenantId,
          planVersionId: version.id,
          planKey: input.planKey,
          currentPlan: planKeyToEnum(input.planKey),
          cycle: input.cycle,
          periodStart: now,
          periodEnd,
          basePriceSnapshot: def.monthlyPrice,
          trialConvertedAt: wasTrial ? now : null,
        },
        update: {
          planVersionId: version.id,
          planKey: input.planKey,
          currentPlan: planKeyToEnum(input.planKey),
          cycle: input.cycle,
          periodStart: now,
          periodEnd,
          basePriceSnapshot: def.monthlyPrice,
          cancelAtPeriodEnd: false,
          downgradeToPlanKey: null,
          downgradeEffectiveAt: null,
          trialConvertedAt: wasTrial ? now : undefined,
        },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { status: "ACTIVE", planVersionId: version.id, plan: planKeyToEnum(input.planKey) },
      });
      for (const [code, qty] of desired) {
        const meta = skuByCode.get(code)!;
        await tx.tenantAddon.upsert({
          where: { tenantId_addonKey: { tenantId, addonKey: code } },
          create: {
            tenantId,
            addonKey: code,
            sku: code,
            quantity: qty,
            active: true,
            priceSnapshot: meta.monthlyPrice,
          },
          update: { sku: code, quantity: qty, active: true, priceSnapshot: meta.monthlyPrice },
        });
      }
      for (const code of toDisable) {
        await tx.tenantAddon.update({
          where: { id: priorByCode.get(code)!.id },
          data: { active: false },
        });
      }

      // ── Events (MRR = signed CHANGE) inside the same transaction ──
      if (wasTrial) {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.TRIAL_CONVERTED,
          { planKey: input.planKey },
          { actorId, tx },
        );
      }
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_CHANGED,
        { fromPlan: priorSub?.planKey ?? null, toPlan: input.planKey, cycle: input.cycle },
        { amountDelta: roundMoney(Number(def.monthlyPrice ?? 0) - oldPlanMonthly), actorId, tx },
      );
      for (const [code, qty] of desired) {
        const prior = priorByCode.get(code);
        const deltaQty = qty - (prior?.qty ?? 0);
        if (deltaQty === 0) continue; // already active at this quantity → no MRR change
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.ADDON_ENABLED,
          { sku: code, quantity: qty },
          { amountDelta: roundMoney(monthlyOf(code) * deltaQty), actorId, tx },
        );
        if (code === "SEAT_EXTRA" && !prior) {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_ADDED,
            { quantity: qty },
            { actorId, tx },
          );
        }
      }
      for (const code of toDisable) {
        const prior = priorByCode.get(code)!;
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.ADDON_DISABLED,
          { sku: code },
          { amountDelta: roundMoney(-monthlyOf(code) * prior.qty), actorId, tx },
        );
        if (code === "SEAT_EXTRA") {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_FREED,
            { quantity: prior.qty },
            { actorId, tx },
          );
        }
      }
    });

    this.entitlements.invalidate(tenantId);
    this.tenantStatus.invalidate(tenantId);
    return { quote, subscription: await this.subscription.getSubscription(tenantId) };
  }

  /** Upgrade to a higher plan — instant, with the prorated price difference charged now. */
  async upgrade(tenantId: string, planKey: string, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === planKey);
    if (!def) throw new BadRequestException(`Unknown plan "${planKey}"`);
    if (def.isCustom) throw new BadRequestException("Enterprise is a custom plan — contact sales.");

    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub?.planKey) throw new BadRequestException("No active subscription — subscribe first.");
    if (planRank(planKey) <= planRank(sub.planKey)) {
      throw new BadRequestException("Target is not an upgrade — use downgrade for a lower plan.");
    }

    const oldMonthly = this.planMonthly(version, sub.planKey);
    const newMonthly = def.monthlyPrice != null ? Number(def.monthlyPrice) : 0;
    const amountDelta = roundMoney(newMonthly - oldMonthly);
    const proratedNow = this.proratedDiff(sub, newMonthly - oldMonthly);

    await this.prisma.$transaction(async (tx) => {
      // Optimistic guard: only apply if still on the expected plan (blocks a concurrent
      // double-upgrade from re-emitting the delta).
      const applied = await tx.tenantSubscription.updateMany({
        where: { tenantId, planKey: sub.planKey },
        data: {
          planKey,
          currentPlan: planKeyToEnum(planKey),
          planVersionId: version.id,
          basePriceSnapshot: def.monthlyPrice,
        },
      });
      if (applied.count === 0) {
        throw new BadRequestException("Plan changed concurrently — please retry.");
      }
      await tx.tenant.update({
        where: { id: tenantId },
        data: { plan: planKeyToEnum(planKey), planVersionId: version.id },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_CHANGED,
        { fromPlan: sub.planKey, toPlan: planKey, instant: true, prorated: proratedNow },
        { amountDelta, actorId, tx },
      );
    });

    this.entitlements.invalidate(tenantId);
    return { proratedNow, subscription: await this.subscription.getSubscription(tenantId) };
  }

  /** Schedule a downgrade at period end (no proration/credit; nothing deleted). */
  async downgrade(
    tenantId: string,
    targetPlanKey: string,
    retainedUserIds: string[],
    actorId?: string,
  ) {
    const version = await this.catalog.getPublishedCatalog();
    const def = version.definitions.find((d) => d.planKey === targetPlanKey);
    if (!def) throw new BadRequestException(`Unknown plan "${targetPlanKey}"`);
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub?.planKey) throw new BadRequestException("No active subscription.");
    if (planRank(targetPlanKey) >= planRank(sub.planKey)) {
      throw new BadRequestException("Target is not a downgrade — use upgrade for a higher plan.");
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: {
          downgradeToPlanKey: targetPlanKey,
          downgradeEffectiveAt: sub.periodEnd,
          retainedUserIds,
        },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.PLAN_DOWNGRADE_SCHEDULED,
        { toPlan: targetPlanKey, effectiveAt: sub.periodEnd, retainedUserIds },
        { amountDelta: 0, actorId, tx },
      );
    });
    // Entitlements unchanged until the cron applies it at period end.
    return this.subscription.getSubscription(tenantId);
  }

  /** Schedule cancellation at period end (reversible via resume). */
  async cancel(tenantId: string, actorId?: string) {
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException("No subscription to cancel.");
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: { cancelAtPeriodEnd: true },
      });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.SUBSCRIPTION_CANCELED,
        { effectiveAt: sub.periodEnd },
        { actorId, tx },
      );
    });
    return this.subscription.getSubscription(tenantId);
  }

  /** Undo a scheduled cancellation. */
  async resume(tenantId: string, actorId?: string) {
    const sub = await this.prisma.tenantSubscription.findUnique({ where: { tenantId } });
    if (!sub) throw new NotFoundException("No subscription.");
    await this.prisma.$transaction(async (tx) => {
      await tx.tenantSubscription.update({
        where: { tenantId },
        data: { cancelAtPeriodEnd: false },
      });
      await this.events.emit(tenantId, BILLING_EVENTS.SUBSCRIPTION_RESUMED, {}, { actorId, tx });
    });
    return this.subscription.getSubscription(tenantId);
  }

  /** Enable an add-on (prorated for the current cycle; SEAT_EXTRA adds seats). */
  async enableAddon(tenantId: string, sku: string, quantity: number | undefined, actorId?: string) {
    const version = await this.catalog.getPublishedCatalog();
    const skuDef = version.addonSkus.find((s) => s.sku === sku);
    if (!skuDef) throw new BadRequestException(`Unknown add-on "${sku}"`);
    if (!isSelfServiceAddon(sku)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
    const qty = Math.max(1, Math.trunc(quantity ?? 1));
    const preview = await this.proration.prorationPreview(tenantId, sku);

    const existing = await this.prisma.tenantAddon.findUnique({
      where: { tenantId_addonKey: { tenantId, addonKey: sku } },
    });
    const priorQty = existing?.active ? existing.quantity : 0;
    const deltaQty = qty - priorQty; // MRR change relative to prior active quantity

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantAddon.upsert({
        where: { tenantId_addonKey: { tenantId, addonKey: sku } },
        create: {
          tenantId,
          addonKey: sku,
          sku,
          quantity: qty,
          active: true,
          priceSnapshot: skuDef.monthlyPrice,
        },
        update: { sku, quantity: qty, active: true, priceSnapshot: skuDef.monthlyPrice },
      });
      if (deltaQty !== 0) {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.ADDON_ENABLED,
          { sku, quantity: qty, prorated: preview.proratedToday },
          { amountDelta: roundMoney(Number(skuDef.monthlyPrice) * deltaQty), actorId, tx },
        );
        if (sku === "SEAT_EXTRA" && priorQty === 0) {
          await this.events.emit(
            tenantId,
            BILLING_EVENTS.SEAT_ADDED,
            { quantity: qty },
            { actorId, tx },
          );
        }
      }
    });

    this.entitlements.invalidate(tenantId);
    return {
      proratedNow: preview.proratedToday,
      subscription: await this.subscription.getSubscription(tenantId),
    };
  }

  /** Disable an add-on. Keeps the row (history read-only); nav/flag simply drops. */
  async disableAddon(tenantId: string, sku: string, actorId?: string) {
    const addon = await this.prisma.tenantAddon.findFirst({
      where: { tenantId, active: true, OR: [{ sku }, { addonKey: sku }] },
    });
    if (!addon) throw new NotFoundException(`Active add-on "${sku}" not found.`);
    // Resolve the CANONICAL code (bridges legacy addonKey like tobacco_dealer → REGULATED_ITEMS).
    const code = addonSkuCode(addon) ?? sku;
    // Symmetric with enableAddon: an admin-granted ("ships dark") add-on is revocable only by
    // platform-admin — self-disabling one is a dead end, since re-enabling it is a 403.
    if (!isSelfServiceAddon(code)) throw new ForbiddenException(ADMIN_ONLY_ADDON_MESSAGE);
    const version = await this.catalog.getPublishedCatalog();
    const skuDef = version.addonSkus.find((s) => s.sku === code);
    const monthly = skuDef ? roundMoney(Number(skuDef.monthlyPrice) * addon.quantity) : 0;

    await this.prisma.$transaction(async (tx) => {
      await tx.tenantAddon.update({ where: { id: addon.id }, data: { active: false } });
      await this.events.emit(
        tenantId,
        BILLING_EVENTS.ADDON_DISABLED,
        { sku: code },
        { amountDelta: -monthly, actorId, tx },
      );
      if (code === "SEAT_EXTRA") {
        await this.events.emit(
          tenantId,
          BILLING_EVENTS.SEAT_FREED,
          { quantity: addon.quantity },
          { actorId, tx },
        );
      }
    });

    this.entitlements.invalidate(tenantId);
    return this.subscription.getSubscription(tenantId);
  }

  /** The prorated charge for a monthly price DELTA over the remaining current period. */
  private proratedDiff(
    sub: { cycle: string; periodStart: Date | null; periodEnd: Date | null },
    monthlyDelta: number,
  ): number {
    const now = new Date();
    if (sub.cycle === "ANNUAL" && sub.periodStart && sub.periodEnd) {
      const aIn = sub.periodEnd.getTime() - sub.periodStart.getTime();
      const aRem = Math.max(0, Math.min(aIn, sub.periodEnd.getTime() - now.getTime()));
      return aIn > 0 ? roundMoney((annualPrice(monthlyDelta) * aRem) / aIn) : 0;
    }
    let start: Date;
    let end: Date;
    if (sub.periodStart && sub.periodEnd && sub.periodStart <= now && now < sub.periodEnd) {
      start = sub.periodStart;
      end = sub.periodEnd;
    } else {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
      end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    const msIn = end.getTime() - start.getTime();
    const msRem = Math.max(0, Math.min(msIn, end.getTime() - now.getTime()));
    return msIn > 0 ? roundMoney((monthlyDelta * msRem) / msIn) : 0;
  }
}
