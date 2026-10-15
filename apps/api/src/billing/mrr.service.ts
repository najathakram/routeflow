import { Injectable } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "@routeflow/pricing";
import { billableAddonWhere } from "./addon-row";

/**
 * SA-140: the one place "is this tenant currently in MrrService's paying set" is defined.
 * `payingWhere`/the add-on `where` (both Prisma filters, DB-side) build FROM this constant;
 * `isPayingRow` (JS-side, for an already-fetched row) reads it too — a Prisma `where` object
 * can't call a JS function, so this is the practical version of "one shared predicate" (L-167):
 * both forms are built from ONE named source instead of two independently-typed copies.
 */
export const PAYING_TENANT_CONDITIONS = {
  status: "ACTIVE" as const,
  deletedAt: null,
  class: "PRODUCTION" as const,
};

/**
 * The full paying-set gate, for a caller that already has the row (no second query). Mirrors
 * `payingWhere` exactly — see `mrr-paying-predicate.parity.spec.ts` for the pin. Every site that
 * decides "does this tenant count toward MRR" from an in-memory tenant snapshot must call this,
 * never re-derive its own `planKey == null` / status / class check (a grep-pin enforces it).
 */
export function isPayingRow(
  tenant: { status: string; deletedAt: Date | null; class: string },
  planKey: string | null,
  // SA-736r M2: REQUIRED, so the compiler finds every site. A subscription whose next recurring invoice is
  // $0 because of discounts (`TenantSubscription.couponFull`, synced from Stripe) is UNBILLED, never paying.
  couponFull: boolean,
): boolean {
  return (
    couponFull !== true &&
    tenant.status === PAYING_TENANT_CONDITIONS.status &&
    // Loose, matching every prior inline copy's `deletedAt == null` — never strict `===`,
    // which would reject `undefined` (a caller's select that never fetched the column).
    tenant.deletedAt == PAYING_TENANT_CONDITIONS.deletedAt &&
    tenant.class === PAYING_TENANT_CONDITIONS.class &&
    planKey != null
  );
}

export interface MrrPlanRow {
  planKey: string;
  tenants: number;
  /** B866 / SA-277: gross base run-rate, before discounts — Σ raw basePriceSnapshot. */
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
   * #2045: the two gaps this comment used to list are both closed —
   *   - BillingService.reconcilePriceLedger() gates its emit on the shared isPayingRow (the full
   *     four-part paying set), so a price edit on a non-paying row books nothing (SA-140 item 1);
   *   - PlatformAdminService.updateTenantClass() books a compensating tenant.class_changed delta
   *     (live contribution − the imported history) when a tenant enters PRODUCTION, with the class
   *     read under the Tenant lock (SA-140 item 2, #2045).
   * A remaining `mrr`/`ledgerMrr` divergence is therefore a real defect to investigate, not a
   * known gap; start from the tenant's BillingEvent stream against its current snapshot.
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
   * SA-736r: ACTIVE, PRODUCTION tenants whose Stripe subscription's next recurring invoice is $0 because of
   * discounts (`couponFull`): UNBILLED - counted here, never in `payingTenants`, `mrr` or `ledgerMrr`.
   */
  couponUnbilledTenants: number;
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
    // SA-736r M2: `couponFull: false` lives on payingWhere itself, so no spread-then-override can drop it.
    const payingWhere = {
      planKey: { not: null },
      couponFull: false,
      tenant: PAYING_TENANT_CONDITIONS,
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
      couponUnbilledTenants,
    ] = await Promise.all([
      this.prisma.tenantSubscription.findMany({
        where: payingWhere,
        select: { tenantId: true, planKey: true, basePriceSnapshot: true, discount: true },
      }),
      this.prisma.tenantAddon.findMany({
        // Mirror `payingWhere`: only count add-ons whose tenant has a PAYING base plan
        // (planKey != null). Otherwise an add-on on a plan-less ACTIVE tenant (e.g. a
        // manual/external-payment activation) would book add-on MRR with no base behind it.
        where: billableAddonWhere({
          active: true,
          // SA-736r M2: a coupon tenant's add-ons leave `mrr` exactly as they leave `ledgerMrr`.
          tenant: {
            ...PAYING_TENANT_CONDITIONS,
            subscription: { planKey: { not: null }, couponFull: false },
          },
        }),
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
      // SA-736r: the unbilled coupon cohort, beside zeroPricedActiveTenants.
      this.prisma.tenantSubscription.count({
        where: { planKey: { not: null }, couponFull: true, tenant: PAYING_TENANT_CONDITIONS },
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
      // B866 / SA-277: gross — the SAME formula as the top-level baseMrr accumulator (L-119).
      // Identity: mrr = Σ rowPrice = baseMrr − discountTotal + addonMrr; Σ byPlan.baseMrr = baseMrr.
      row.baseMrr = roundMoney(row.baseMrr + base);
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
      couponUnbilledTenants,
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
   *
   * SA-140: `db` defaults to `this.prisma` but accepts an enclosing transaction's client — a
   * caller computing a compensating delta for a write it just made (e.g.
   * PlatformAdminService.updateTenantClass() flipping `class` into PRODUCTION) must call this
   * WITH that transaction's `tx`, AFTER the write, inside the SAME transaction. Called without
   * `tx` (or from outside any transaction, or before the write commits), this reads the
   * pre-write row under normal read-committed isolation and silently prices the OLD state —
   * here specifically the OLD `class`, so it would return 0 for a tenant that (post-commit) is
   * actually PRODUCTION, understating the compensation with no error.
   */
  async priceTenant(
    tenantId: string,
    db: Pick<PrismaService, "tenant" | "tenantAddon"> = this.prisma,
  ): Promise<number> {
    // Gate must match computeOverview()'s payingWhere EXACTLY (review finding) — it also
    // requires deletedAt: null. Without it, a soft-deleted tenant that a webhook later
    // flips back to ACTIVE (deletedAt untouched by that CAS) prices nonzero here while
    // still contributing $0 to the dashboard: the exact divergence this function exists
    // to close, just relocated.
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        status: true,
        class: true,
        deletedAt: true,
        subscription: {
          select: { planKey: true, basePriceSnapshot: true, discount: true, couponFull: true },
        },
      },
    });
    if (
      !tenant ||
      !isPayingRow(
        tenant,
        tenant.subscription?.planKey ?? null,
        tenant.subscription?.couponFull ?? false,
      )
    ) {
      return 0;
    }
    const addons = await db.tenantAddon.findMany({
      where: billableAddonWhere({ tenantId, active: true }),
      select: { priceSnapshot: true, quantity: true },
    });
    return this.priceSubscription(tenant.subscription!, addons);
  }
}
