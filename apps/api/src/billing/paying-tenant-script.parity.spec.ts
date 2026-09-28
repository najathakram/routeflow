/**
 * #2639 / SA-481c: the destructive scripts (wipe-tenant-fresh-start, backfill-b294) refuse a paying
 * target through `apps/api/scripts/lib/paying-tenant.cjs`. A script cannot import the TS service, so
 * that predicate is pinned HERE to the API's own `isPayingRow` / `PAYING_TENANT_CONDITIONS` over the
 * full input matrix — a drift in either side is a red build, never a silently-unguarded wipe.
 */
import { isPayingRow, PAYING_TENANT_CONDITIONS } from "./mrr.service";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const lib = require("../../scripts/lib/paying-tenant.cjs");

describe("#2639 scripts/lib/paying-tenant.cjs agrees with mrr.service's isPayingRow", () => {
  it("carries the same paying-set conditions", () => {
    expect(lib.PAYING_TENANT_CONDITIONS).toEqual(PAYING_TENANT_CONDITIONS);
  });

  const STATUSES = ["ACTIVE", "TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED", "PENDING_SETUP"];
  const CLASSES = ["PRODUCTION", "DEMO", "TEST", "INTERNAL"];
  const DELETED: Array<Date | null | undefined> = [null, undefined, new Date("2026-01-01")];
  const PLAN_KEYS: Array<string | null> = ["STARTER", null];
  for (const status of STATUSES) {
    for (const cls of CLASSES) {
      for (const deletedAt of DELETED) {
        for (const planKey of PLAN_KEYS) {
          it(`${status} / ${cls} / deletedAt ${String(deletedAt && "set")} / planKey ${planKey}`, () => {
            const tenant = { status, class: cls, deletedAt: deletedAt as Date | null };
            expect(lib.isPayingTenant(tenant, planKey)).toBe(isPayingRow(tenant, planKey));
          });
        }
      }
    }
  }
});

describe("#2639 / SA-547 isProtectedTenant = paying ∨ (Stripe-linked ∧ not deleted)", () => {
  const active = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
  it("a paying tenant is protected on the 'paying' arm", () => {
    expect(lib.protectedArm(active, { planKey: "STARTER" })).toBe("paying");
    expect(lib.isProtectedTenant(active, { planKey: "STARTER" })).toBe(true);
  });
  it("the Stripe arm ALONE protects — TEST class, no planKey, not ACTIVE", () => {
    const t = { status: "READ_ONLY", class: "TEST", deletedAt: null };
    const sub = { planKey: null, stripeSubId: "sub_fake_qa" };
    expect(lib.protectedArm(t, sub)).toBe("stripe-linked");
    expect(lib.isProtectedTenant(t, sub)).toBe(true);
  });
  it("a soft-deleted Stripe-linked tenant is NOT protected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: new Date() };
    expect(lib.isProtectedTenant(t, { planKey: null, stripeSubId: "sub_fake_qa" })).toBe(false);
  });
  it("a non-paying, unlinked tenant (or no subscription row) is unprotected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: null };
    expect(lib.protectedArm(t, { planKey: "STARTER", stripeSubId: null })).toBeNull();
    expect(lib.protectedArm(t, null)).toBeNull();
    expect(lib.protectedArm(active, undefined)).toBeNull();
  });
});
