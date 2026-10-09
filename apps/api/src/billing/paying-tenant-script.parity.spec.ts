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
  // SA-736r M2: couponFull is part of the matrix - true is never paying, false is as before.
  const COUPON_FULL = [false, true];
  for (const status of STATUSES) {
    for (const cls of CLASSES) {
      for (const deletedAt of DELETED) {
        for (const planKey of PLAN_KEYS) {
          for (const couponFull of COUPON_FULL) {
            it(`${status} / ${cls} / deletedAt ${String(deletedAt && "set")} / planKey ${planKey} / couponFull ${couponFull}`, () => {
              const tenant = { status, class: cls, deletedAt: deletedAt as Date | null };
              expect(lib.isPayingTenant(tenant, planKey, couponFull)).toBe(
                isPayingRow(tenant, planKey, couponFull),
              );
            });
          }
        }
      }
    }
  }

  it("SA-736r: a couponFull tenant is NOT paying (script and API), an otherwise-identical one is", () => {
    const tenant = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    expect(lib.isPayingTenant(tenant, "STARTER", false)).toBe(true);
    expect(lib.isPayingTenant(tenant, "STARTER", true)).toBe(false);
    expect(isPayingRow(tenant, "STARTER", true)).toBe(false);
  });

  it("SA-736r: the script mirror THROWS on an undefined couponFull (a select that never fetched it)", () => {
    const tenant = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    expect(() => lib.isPayingTenant(tenant, "STARTER", undefined)).toThrow(/couponFull/);
    expect(() => lib.isPayingTenant(tenant, "STARTER")).toThrow(/couponFull/);
    expect(() => lib.isPayingTenant(tenant, "STARTER", null)).toThrow(/couponFull/);
  });

  it("SA-736r review: protectedArm does NOT coerce an undefined couponFull - a subscription whose select skipped it throws", () => {
    const active = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    expect(() => lib.protectedArm(active, { planKey: "STARTER", stripeSubId: null })).toThrow(
      /couponFull/,
    );
    // no subscription row, or no plan: never paying, nothing to coerce
    expect(lib.protectedArm(active, null)).toBeNull();
    expect(lib.protectedArm(active, { planKey: null, stripeSubId: null })).toBeNull();
  });

  it("SA-736r: a coupon tenant stays PROTECTED through its stripe-linked arm", () => {
    const tenant = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    const sub = {
      planKey: "STARTER",
      stripeSubId: "sub_acme",
      couponFull: true,
    };
    expect(lib.protectedArm(tenant, sub)).toBe("stripe-linked");
    expect(lib.isProtectedTenant(tenant, sub)).toBe(true);
  });
});

describe("#2639 / SA-547 isProtectedTenant = paying ∨ (Stripe-linked ∧ not deleted)", () => {
  const active = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
  it("a paying tenant is protected on the 'paying' arm", () => {
    expect(lib.protectedArm(active, { planKey: "STARTER", couponFull: false })).toBe("paying");
    expect(lib.isProtectedTenant(active, { planKey: "STARTER", couponFull: false })).toBe(true);
  });
  it("the Stripe arm ALONE protects — TEST class, no planKey, not ACTIVE", () => {
    const t = { status: "READ_ONLY", class: "TEST", deletedAt: null };
    const sub = { planKey: null, stripeSubId: "sub_fake_qa", couponFull: false };
    expect(lib.protectedArm(t, sub)).toBe("stripe-linked");
    expect(lib.isProtectedTenant(t, sub)).toBe(true);
  });
  it("a soft-deleted Stripe-linked tenant is NOT protected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: new Date() };
    expect(
      lib.isProtectedTenant(t, { planKey: null, stripeSubId: "sub_fake_qa", couponFull: false }),
    ).toBe(false);
  });
  it("a non-paying, unlinked tenant (or no subscription row) is unprotected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: null };
    expect(
      lib.protectedArm(t, { planKey: "STARTER", stripeSubId: null, couponFull: false }),
    ).toBeNull();
    expect(lib.protectedArm(t, null)).toBeNull();
    expect(lib.protectedArm(active, undefined)).toBeNull();
  });
});
