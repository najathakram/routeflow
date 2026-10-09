// #2639 / SA-481c — the ONE "is this tenant paying?" predicate for destructive scripts
// (wipe-tenant-fresh-start, backfill-b294), which cannot import the API's TypeScript services.
//
// It is apps/api/src/billing/mrr.service.ts's `isPayingRow` / `PAYING_TENANT_CONDITIONS`, verbatim:
// ACTIVE, not soft-deleted, PRODUCTION class, and a subscription with a planKey. The parity spec
// (apps/api/src/billing/paying-tenant-script.parity.spec.ts) pins the two over the full input
// matrix, so a change to the paying set on either side is a red build. Never re-derive this inline
// in a script — require it from here.
//
// Pure: no connection, no logging, no exit.

const PAYING_TENANT_CONDITIONS = {
  status: "ACTIVE",
  deletedAt: null,
  class: "PRODUCTION",
};

/**
 * SA-736r M2: `couponFull` is REQUIRED (a boolean). `undefined` - a select that never fetched the column -
 * THROWS, so a script can never silently count a coupon-unbilled tenant as paying.
 *
 * @param {{ status: string, deletedAt: Date | null | undefined, class: string }} tenant
 * @param {string | null | undefined} planKey the tenant's TenantSubscription.planKey
 * @param {boolean} couponFull the tenant's TenantSubscription.couponFull
 * @returns {boolean}
 */
function isPayingTenant(tenant, planKey, couponFull) {
  if (typeof couponFull !== "boolean") {
    throw new TypeError(
      "isPayingTenant: couponFull must be a boolean (select it with the subscription)",
    );
  }
  return (
    couponFull !== true &&
    tenant.status === PAYING_TENANT_CONDITIONS.status &&
    // Loose, exactly like isPayingRow: `undefined` (a select that never fetched it) reads as null.
    tenant.deletedAt == PAYING_TENANT_CONDITIONS.deletedAt &&
    tenant.class === PAYING_TENANT_CONDITIONS.class &&
    planKey != null
  );
}

/**
 * SA-547: what a destructive script REFUSES by default — wider than "paying" (which keeps its one MRR
 * meaning, SA-513): a paying tenant, OR any non-deleted tenant whose subscription is linked to Stripe
 * (any class, any status). Returns which arm fired, so the refusal can name it; null = unprotected.
 *
 * @param {{ status: string, deletedAt: Date | null | undefined, class: string }} tenant
 * @param {{ planKey?: string | null, stripeSubId?: string | null } | null | undefined} sub
 * @returns {"paying" | "stripe-linked" | null}
 */
function protectedArm(tenant, sub) {
  // A coupon-unbilled tenant is not "paying" - it still has a stripeSubId, so it stays PROTECTED via the next arm.
  if (isPayingTenant(tenant, sub?.planKey ?? null, sub?.couponFull === true)) return "paying";
  if (sub?.stripeSubId != null && tenant.deletedAt == null) return "stripe-linked";
  return null;
}

/** SA-547: isPayingTenant ∨ (stripeSubId ≠ null ∧ not deleted). */
function isProtectedTenant(tenant, sub) {
  return protectedArm(tenant, sub) !== null;
}

module.exports = { PAYING_TENANT_CONDITIONS, isPayingTenant, isProtectedTenant, protectedArm };
