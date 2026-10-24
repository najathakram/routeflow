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
 * SA-547 + row 195: what a live-capable script REFUSES by default — wider than "paying" (which keeps
 * its one MRR meaning, SA-513): a paying tenant, OR any non-deleted tenant whose subscription is
 * linked to Stripe (any class, any status), OR a tenant the operator named in
 * PROTECTED_TENANT_SLUGS (the "env-listed" arm: a new trial tenant that is neither paying nor
 * Stripe-linked yet). Returns which arm fired, so the refusal can name it; null = unprotected.
 *
 * `protectedSlugs` is the Set from protected-slugs.cjs `loadProtectedSlugs` and is REQUIRED — there
 * is deliberately no process.env default, so a caller that forgot to load it fails loudly instead of
 * silently protecting nobody. The env-listed arm matches the trimmed, lower-cased slug and IGNORES
 * deletedAt: a soft-deleted tenant the operator listed stays protected.
 *
 * @param {{ slug?: string, status: string, deletedAt: Date | null | undefined, class: string }} tenant
 * @param {{ planKey?: string | null, stripeSubId?: string | null, couponFull?: boolean } | null | undefined} sub
 * @param {Set<string>} protectedSlugs
 * @returns {"paying" | "stripe-linked" | "env-listed" | null}
 */
function protectedArm(tenant, sub, protectedSlugs) {
  if (!(protectedSlugs instanceof Set))
    throw new TypeError("protectedArm needs the protectedSlugs Set from loadProtectedSlugs");
  // A coupon-unbilled tenant is not "paying" - it still has a stripeSubId, so it stays PROTECTED via the next arm.
  // `couponFull` is NOT coerced: a subscription whose select never fetched it THROWS (isPayingTenant). A target
  // with no subscription row, or no plan, is never paying and needs no flag.
  if (sub && sub.planKey != null && isPayingTenant(tenant, sub.planKey, sub.couponFull))
    return "paying";
  if (sub?.stripeSubId != null && tenant.deletedAt == null) return "stripe-linked";
  if (protectedSlugs.size > 0) {
    // Fail closed: with a non-empty list, a row whose slug was never fetched cannot be judged.
    if (typeof tenant.slug !== "string")
      throw new TypeError("protectedArm needs the tenant slug (select it) when slugs are listed");
    if (protectedSlugs.has(tenant.slug.trim().toLowerCase())) return "env-listed";
  }
  return null;
}

/** SA-547: isPayingTenant ∨ (stripeSubId ≠ null ∧ not deleted) ∨ env-listed. */
function isProtectedTenant(tenant, sub, protectedSlugs) {
  return protectedArm(tenant, sub, protectedSlugs) !== null;
}

module.exports = { PAYING_TENANT_CONDITIONS, isPayingTenant, isProtectedTenant, protectedArm };
