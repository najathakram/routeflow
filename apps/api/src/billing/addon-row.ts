import { TenantStatus } from "@prisma/client";
import type { Prisma } from "@prisma/client";
import { toCents } from "@routeflow/pricing";
import { LEGACY_ADDON_KEY_TO_SKU } from "./plan-catalog.constants";

/**
 * #2188 / SA-385: the ONE way to find a tenant's TenantAddon row for an add-on.
 *
 * An add-on can be keyed two ways — admin enableAddon writes the raw legacy addonKey
 * ("tobacco_dealer"), subscribe()/self-serve write the SKU ("REGULATED_ITEMS") — and the
 * (tenantId, addonKey) unique cannot stop the pair because the keys differ. Every existence read
 * (admin enable pre-check + in-tx re-check, admin disable, subscribe, self-serve enable/disable,
 * hasAddon) goes through this predicate, so either path finds the other's row and re-activates it
 * in place instead of creating a second one.
 *
 * The legacy keys come from the INVERSE of {@link LEGACY_ADDON_KEY_TO_SKU} — never a second map.
 */

/** The canonical code for a raw admin addonKey (a legacy key maps to its SKU; anything else is itself). */
export function addonCodeOf(addonKey: string): string {
  return LEGACY_ADDON_KEY_TO_SKU[addonKey] ?? addonKey;
}

/** Every legacy addonKey whose map value is `sku`. */
export function legacyKeysFor(sku: string): string[] {
  return Object.keys(LEGACY_ADDON_KEY_TO_SKU).filter((k) => LEGACY_ADDON_KEY_TO_SKU[k] === sku);
}

/** The shared predicate: addonKey = sku, OR sku = sku, OR addonKey is one of sku's legacy keys. */
export function addonRowWhere(tenantId: string, sku: string): Prisma.TenantAddonWhereInput {
  const legacy = legacyKeysFor(sku);
  return {
    tenantId,
    OR: [{ addonKey: sku }, { sku }, ...(legacy.length ? [{ addonKey: { in: legacy } }] : [])],
  };
}

/** The same predicate for rows already in memory (subscribe's locked findMany). */
export function addonRowMatches(row: { addonKey: string; sku?: string | null }, sku: string) {
  return row.addonKey === sku || row.sku === sku || legacyKeysFor(sku).includes(row.addonKey);
}

type AddonReader = { tenantAddon: Pick<Prisma.TenantAddonDelegate, "findFirst"> };

/**
 * The tenant's row for `sku` — an active row first, then the oldest — or null. A tenant that
 * already holds two rows (pre-#2188 data, reported by report-b2188-duplicate-addon-rows.mjs) gets
 * a deterministic pick; deduping those is its own ruling.
 */
export function findAddonRow(db: AddonReader, tenantId: string, sku: string) {
  return db.tenantAddon.findFirst({
    where: addonRowWhere(tenantId, sku),
    orderBy: [{ active: "desc" }, { createdAt: "asc" }],
  });
}

/**
 * SA-693: the ONE predicate for "a row the platform bills (or is owed a bill for)". A comp row
 * (`isComp`) is a platform grant: never billed, never booked as revenue, never blocking a checkout.
 * Every reader that asks "is this add-on billable / unbilled / revenue?" spreads this into its
 * `where` (the checkout gate, MRR) — Option A's line items and adoption reuse it too — instead of
 * re-spelling `isComp: false`.
 */
export function billableAddonWhere(
  where: Prisma.TenantAddonWhereInput = {},
): Prisma.TenantAddonWhereInput {
  return { ...where, isComp: false };
}

type BillableRowLike = {
  addonKey: string;
  sku?: string | null;
  active?: boolean | null;
  isComp?: boolean | null;
  priceSnapshot?: unknown;
};

/**
 * SA-815c / SA-815d: an active, non-comp row an admin PRICED above zero, that is not seat plumbing - the rows whose
 * stored price the card checkout has to match to a catalog item before it bills them.
 *
 * SEAT_EXTRA is excluded HERE and nowhere else: seats bill through the plan quantity, never through an add-on item.
 */
export function isPricedBillableCandidate(row: BillableRowLike): boolean {
  if (!row.active || row.isComp) return false;
  if ((row.sku ?? addonCodeOf(row.addonKey)) === "SEAT_EXTRA") return false;
  return Number(row.priceSnapshot ?? 0) > 0;
}

/**
 * SA-815c / SA-815d: the ONE predicate for "the card checkout bills this ADMIN-ONLY row through a Stripe item" -
 * it decides BILLING only (the ledger's booking at the reactivation crossing is unchanged, so live and ledger MRR
 * keep agreeing). A candidate ({@link isPricedBillableCandidate}) whose stored price EQUALS the billing catalog
 * price of its SKU (cents) and that price is above zero: the item is created at exactly what the row says.
 * Anything else (a SKU the catalog prices at $0 or does not list, or a custom price above or below the catalog)
 * is never billed here: billing it at the catalog price would silently change what was agreed, and the caller
 * raises a platform notice instead. Self-serve rows keep their own rule (billed at the catalog price) and do not
 * go through this.
 */
export function isStripeBillableAddonRow(
  row: BillableRowLike,
  catalogMonthlyPrice: unknown,
): boolean {
  if (!isPricedBillableCandidate(row)) return false;
  const catalog = toCents(Number(catalogMonthlyPrice ?? 0));
  return catalog > 0 && catalog === toCents(Number(row.priceSnapshot));
}

/**
 * SA-690 (MUST-1): a trial keeps its self-serve add-ons across the plan pick — and so does a LAPSED one,
 * a tenant that is READ_ONLY because its trial expired or was cancelled (its rows are still the unbilled
 * trial rows the card checkout is meant to bill). Any other READ_ONLY reason (a cancelled paid
 * subscription) is not a trial. It decides two things: what subscribe() drops (`wasTrial` keeps its other
 * meanings: the TRIAL_CONVERTED event, `trialConvertedAt`), and whether a MANUAL activation prices the
 * tenant's unbilled add-ons (manual-activation-addons.ts). It lives in this leaf module so neither of those
 * imports the other's service.
 */
export function keepsTrialAddons(t: { status: string; readOnlyReason?: string | null }): boolean {
  return (
    t.status === TenantStatus.TRIAL ||
    (t.status === TenantStatus.READ_ONLY &&
      (t.readOnlyReason === "trial_expired" || t.readOnlyReason === "trial_cancelled"))
  );
}
