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
 * @param {{ status: string, deletedAt: Date | null | undefined, class: string }} tenant
 * @param {string | null | undefined} planKey the tenant's TenantSubscription.planKey
 * @returns {boolean}
 */
function isPayingTenant(tenant, planKey) {
  return (
    tenant.status === PAYING_TENANT_CONDITIONS.status &&
    // Loose, exactly like isPayingRow: `undefined` (a select that never fetched it) reads as null.
    tenant.deletedAt == PAYING_TENANT_CONDITIONS.deletedAt &&
    tenant.class === PAYING_TENANT_CONDITIONS.class &&
    planKey != null
  );
}

module.exports = { PAYING_TENANT_CONDITIONS, isPayingTenant };
