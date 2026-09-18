import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "@routeflow/pricing";

export interface MrrPlanRow {
  planKey: string;
  tenants: number;
  baseMrr: number;
}

export interface MrrOverview {
  /** Monthly run-rate = Σ(base + add-ons − discounts) over paying (ACTIVE, subscribed) tenants. */
  mrr: number;
  baseMrr: number;
  addonMrr: number;
  discountTotal: number;
  payingTenants: number;
  trialTenants: number;
  readOnlyTenants: number;
  byPlan: MrrPlanRow[];
  /**
   * Reconciliation: Σ of the append-only BillingEvent.amountDelta ledger. Tracks `mrr` for
   * tenants managed through the plans-as-data lifecycle (subscribe / change / add-on / scheduled
   * cancellation all emit signed deltas). Legacy Stripe-only churn (billing.service
   * onSubscriptionDeleted / suspendOverdueTenants) DOES emit a compensating delta too, via the
   * shared transitionAndEmit() helper — this comment used to say otherwise; that was stale and
   * pointed investigators at the wrong mechanism (B544).
   *
   * B557 (fixed): PlatformAdminService.updateStatus() (the tenant detail page's plain
   * Suspend/Reactivate button) used to flip tenant.status with a raw write and never emit a
   * delta, in either direction — it now emits a compensating SUBSCRIPTION_SUSPENDED/
   * SUBSCRIPTION_CANCELED/SUBSCRIPTION_RESUMED delta whenever the write crosses this file's
   * payingWhere boundary. activateManualSubscription() (B551's mirror-image gap — could move a
   * tenant into the paying set with no emit at all) is fixed the same way, booking a
   * PLAN_CHANGED delta. Deliberately NOT fixed by narrowing this query to match payingWhere —
   * that would make `mrr`/`ledgerMrr` agree by construction and permanently disable the
   * reconciliation check the divergence between them exists to provide.
   *
   * The gaps that DO still exist today, and can drift `ledgerMrr` away from `mrr`:
   *   - BillingService.reconcilePriceLedger() only mirrors this file's `planKey != null`
   *     condition, not the full four-part payingWhere (status/deletedAt/class too) — a price
   *     edit on a non-ACTIVE-but-still-PRODUCTION tenant can book a delta live `mrr` never sees.
   *   - PlatformAdminService.updateTenantClass() retroactively imports a tenant's ENTIRE
   *     historical delta stream into this SUM the moment it flips a tenant into PRODUCTION
   *     (this query re-scopes by CURRENT class, not class-at-event-time), with no compensating
   *     entry for that import.
   * See apps/api/scripts/report-mrr-ledger-drift.mjs for a read-only tool that finds which
   * tenant(s) and which of the above account for a given drift.
   */
  ledgerMrr: number;
  /** Net MRR change over the last 30 days (Σ amountDelta in that window). */
  momDelta: number;
  /**
   * REG-743-N5/F2 (visibility, not a policy change): a paying-scoped (ACTIVE, PRODUCTION,
   * planKey set) subscription row with a null basePriceSnapshot that ALSO prices at $0 net —
   * a legacy/hand-written row that carries a planKey and a real Stripe subscription but was
   * never snapshotted (NOT the Stripe checkout-webhook shape: `onCheckoutCompleted` never
   * sets planKey itself, so that row lands in `activeWithoutSubscription` instead — see
   * `scripts/backfill-subscription-reconciliation.mjs`'s header for the reachable population
   * this mirrors). Computed from the same per-row `priceSubscription()` result as `payingTenants` (never a
   * separate raw-column check), so a null snapshot rescued by add-on revenue is counted as
   * paying, never double-labeled "unpriced" — see F4 in the REG-743 fix-round review. $0 is
   * the CORRECT figure for these; this count exists so that figure is never silent.
   */
  unpricedActiveTenants: number;
  /**
   * REG-743-N5/F2 (review finding F2): a paying-scoped row that DOES have a basePriceSnapshot
   * but nets to exactly $0 anyway (e.g. a full discount) — the "free pilot with a real Stripe
   * subscription" shape. Disjoint from `unpricedActiveTenants` (that one requires a null
   * snapshot); together the two cover every payingWhere row `payingTenants` excludes.
   */
  zeroPricedActiveTenants: number;
  /**
   * REG-743-N5/F2 (review finding F3): an ACTIVE PRODUCTION tenant with nothing billable on
   * file — no subscription row at all, OR a subscription row that never got a `planKey`
   * backfilled (the legacy Stripe-only shape `billing.service.ts` already treats as a MRR
   * no-op). Both shapes are structurally excluded from `payingWhere` and therefore invisible
   * to every other count above; widened here rather than added as a separate field, since
   * "no plan key" and "no subscription row" are the same claim for billing purposes.
   */
  activeWithoutSubscription: number;
}

/**
 * Server-side MRR rollup (Plans & Billing Phase 6). Prices from the per-tenant PRICE
 * SNAPSHOTS (basePriceSnapshot / addon priceSnapshot) so grandfathered pricing is
 * honoured, and reconciles the total against the append-only BillingEvent ledger.
 * MRR is a MONTHLY run-rate (annual subs count their monthly-equivalent snapshot).
 *
 * MRR-truth / feature-override exclusion (feature grants v2, brief B): every query in
 * `computeOverview()` and `priceTenant()` reads ONLY `tenantSubscription` and `tenantAddon` —
 * `tenantFeatureOverride` (any `kind`: PILOT/SUPPORT/COMP/TRIAL/GRANDFATHER) is never queried
 * here at all, so a feature-override GRANT can never inflate MRR by construction, not by a
 * filter that could drift. `FeatureOverrideService.create()`/`revoke()` write only that table
 * and never call Stripe (see feature-override.service.spec.ts) — a GRANT on a paid addon-gated
 * key unlocks the GATE (AddonGuard/PlanFlagGuard), it does not create a `TenantAddon` row, so
 * it stays invisible to `addonMrr`/`baseMrr` until someone actually purchases the AddonSku.
 * Regression oracle: mrr.service.spec.ts's "feature-override MRR exclusion oracle" describe
 * block. SEAM: the tenant-facing "why does this flag work" summary
 * (`SubscriptionService.getSubscription`'s merged `flags` array) has no per-flag `source`
 * annotation yet — that file is brief A's, out of scope here; `FeatureSource` (schema,
 * OVERRIDE_GRANT/OVERRIDE_DENY/ADDON_SKU/PRESET/NONE) is the future home for it.
 */
@Injectable()
export class MrrService {
  constructor(private readonly prisma: PrismaService) {}

  async computeOverview(): Promise<MrrOverview> {
    // Phase 0 T9: every query below scopes by tenant.class === "PRODUCTION" — the first
    // five customers are FREE PILOTS/TRIALS and every TEST/DEMO/INTERNAL tenant (routeflow-demo,
    // qa-*/e2e-*/ux-audit-* slugs, routeflow-hq) must be invisible to revenue everywhere,
    // not just here in the paying-subscription filter.
    const payingWhere = {
      planKey: { not: null },
      tenant: { status: "ACTIVE" as const, deletedAt: null, class: "PRODUCTION" as const },
    };
    const now = new Date();
    // Fixed trailing 30-day window. (Decrementing the month component instead overflows
    // short months — e.g. Date.UTC(y, 1, 31) rolls forward into March — silently dropping
    // in-window events on ~7 month-end days a year.)
    const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const activeProductionWhere = {
      status: "ACTIVE" as const,
      deletedAt: null,
      class: "PRODUCTION" as const,
    };

    const [
      subs,
      addons,
      trialTenants,
      readOnlyTenants,
      ledgerAgg,
      momAgg,
      activeWithoutSubscription,
    ] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: payingWhere,
        select: { tenantId: true, planKey: true, basePriceSnapshot: true, discount: true },
      }),
      this.prisma.tenantAddon.findMany({
        // Mirror `payingWhere`: only count add-ons whose tenant has a PAYING base plan
        // (planKey != null). Otherwise an add-on on a plan-less ACTIVE tenant (e.g. a
        // manual/external-payment activation) would book add-on MRR with no base behind it.
        where: {
          active: true,
          tenant: {
            status: "ACTIVE",
            deletedAt: null,
            class: "PRODUCTION",
            subscription: { planKey: { not: null } },
          },
        },
        select: { tenantId: true, priceSnapshot: true, quantity: true },
      }),
      this.prisma.tenant.count({
        where: { status: "TRIAL", deletedAt: null, class: "PRODUCTION" },
      }),
      this.prisma.tenant.count({
        where: { status: "READ_ONLY", deletedAt: null, class: "PRODUCTION" },
      }),
      this.prisma.billingEvent.aggregate({
        _sum: { amountDelta: true },
        where: { tenant: { class: "PRODUCTION" } },
      }),
      this.prisma.billingEvent.aggregate({
        _sum: { amountDelta: true },
        where: { createdAt: { gte: monthAgo }, tenant: { class: "PRODUCTION" } },
      }),
      // REG-743-N5/F2: visibility, not a policy change — $0 stays correct for these rows,
      // this just makes sure it is never SILENT. unpricedActiveTenants/zeroPricedActiveTenants
      // are NOT queried here — they're derived below from the same per-row priceSubscription()
      // result as payingTenants (review finding F4: a raw basePriceSnapshot-null check would
      // wrongly flag a row that add-ons still price above $0). Widened for review finding F3:
      // a subscription row with no planKey never reaches `payingWhere` either, and is the
      // same "nothing billable" claim as no subscription row at all.
      this.prisma.tenant.count({
        where: {
          ...activeProductionWhere,
          OR: [{ subscription: null }, { subscription: { planKey: null } }],
        },
      }),
    ]);

    // REG-743-N1 (L-119): group add-ons by tenant so each subscription's contribution is
    // priced through the exact same `priceSubscription()` a single tenant's card
    // (`priceTenant()`) calls — the platform total is a sum of per-tenant prices BY
    // CONSTRUCTION, not two independently-aggregated queries that can drift apart.
    const addonsByTenant = new Map<string, { priceSnapshot: unknown; quantity: number }[]>();
    for (const a of addons) {
      const list = addonsByTenant.get(a.tenantId) ?? [];
      list.push(a);
      addonsByTenant.set(a.tenantId, list);
    }

    let baseMrr = 0;
    let addonMrr = 0;
    let discountTotal = 0;
    let mrr = 0;
    let payingTenants = 0;
    let unpricedActiveTenants = 0;
    let zeroPricedActiveTenants = 0;
    const byPlanMap = new Map<string, { tenants: number; baseMrr: number }>();
    for (const s of subs) {
      const base = s.basePriceSnapshot != null ? Number(s.basePriceSnapshot) : 0;
      const discount = Number(s.discount ?? 0);
      const tenantAddons = addonsByTenant.get(s.tenantId) ?? [];
      const addonSum = tenantAddons.reduce(
        (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
        0,
      );
      baseMrr += base;
      discountTotal += discount;
      addonMrr += addonSum;
      const rowPrice = this.priceSubscription(s, tenantAddons);
      mrr += rowPrice;
      const key = s.planKey as string;
      const row = byPlanMap.get(key) ?? { tenants: 0, baseMrr: 0 };
      row.baseMrr = roundMoney(row.baseMrr + base - discount);
      // REG-743-N5: a row's `payingWhere` match (a planKey) is not the same claim as "this
      // tenant pays" — a null snapshot or a full discount prices it $0. Count it as paying
      // ONLY when it actually contributes money, so "N paying tenants" and "$0" are never
      // both true for the same row.
      if (rowPrice > 0) {
        payingTenants += 1;
        row.tenants += 1;
      } else if (s.basePriceSnapshot == null) {
        // Missing a snapshot AND add-ons didn't rescue it above $0 — genuinely unpriced.
        unpricedActiveTenants += 1;
      } else {
        // Has a snapshot, still nets to $0 (e.g. a full discount) — a real Stripe
        // subscription that happens to be a free pilot, not a missing-data case.
        zeroPricedActiveTenants += 1;
      }
      byPlanMap.set(key, row);
    }

    baseMrr = roundMoney(baseMrr);
    const roundedAddon = roundMoney(addonMrr);
    const roundedDiscount = roundMoney(discountTotal);
    mrr = roundMoney(mrr);

    const byPlan: MrrPlanRow[] = [...byPlanMap.entries()]
      .map(([planKey, v]) => ({ planKey, tenants: v.tenants, baseMrr: v.baseMrr }))
      .sort((a, b) => b.baseMrr - a.baseMrr);

    return {
      mrr,
      baseMrr,
      addonMrr: roundedAddon,
      discountTotal: roundedDiscount,
      payingTenants,
      trialTenants,
      readOnlyTenants,
      byPlan,
      ledgerMrr: roundMoney(Number(ledgerAgg._sum.amountDelta ?? 0)),
      momDelta: roundMoney(Number(momAgg._sum.amountDelta ?? 0)),
      unpricedActiveTenants,
      zeroPricedActiveTenants,
      activeWithoutSubscription,
    };
  }

  /**
   * Pure per-row pricing: base snapshot − discount + Σ(addon price × qty), rounded. No
   * tenant/status/class gate — `computeOverview()` and `priceTenant()` both apply that
   * themselves, over rows already scoped to paying PRODUCTION tenants.
   */
  priceSubscription(
    sub: { basePriceSnapshot: unknown; discount?: unknown },
    addons: { priceSnapshot: unknown; quantity: number }[],
  ): number {
    const base = sub.basePriceSnapshot != null ? Number(sub.basePriceSnapshot) : 0;
    const discount = Number(sub.discount ?? 0);
    const addonSum = addons.reduce(
      (sum, a) => sum + (a.priceSnapshot != null ? Number(a.priceSnapshot) : 0) * a.quantity,
      0,
    );
    return roundMoney(base - discount + addonSum);
  }

  /**
   * REG-743-N1 (L-119): the one function a single tenant's admin-detail card prices through —
   * the SAME gate `computeOverview()` applies (non-PRODUCTION or non-ACTIVE → $0, no
   * exceptions; no subscription or no planKey → $0, never a catalog-price guess), so the card
   * and the platform-wide rollup can never diverge by construction. Replaces the retired
   * `_monthlyPriceUsd`/`_catalogPriceByPlanKey` catalog-fallback estimator.
   */
  async priceTenant(tenantId: string): Promise<number> {
    // Gate must match computeOverview()'s payingWhere EXACTLY (review finding) — it also
    // requires deletedAt: null. Without it, a soft-deleted tenant that a webhook later
    // flips back to ACTIVE (deletedAt untouched by that CAS) prices nonzero here while
    // still contributing $0 to the dashboard: the exact divergence this function exists
    // to close, just relocated.
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        class: true,
        deletedAt: true,
        subscription: { select: { planKey: true, basePriceSnapshot: true, discount: true } },
      },
    });
    if (
      !tenant ||
      tenant.status !== "ACTIVE" ||
      tenant.class !== "PRODUCTION" ||
      tenant.deletedAt != null ||
      !tenant.subscription ||
      tenant.subscription.planKey == null
    ) {
      return 0;
    }
    const addons = await this.prisma.tenantAddon.findMany({
      where: { tenantId, active: true },
      select: { priceSnapshot: true, quantity: true },
    });
    return this.priceSubscription(tenant.subscription, addons);
  }
}
