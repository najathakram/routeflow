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

const NONE = new Set<string>();

describe("#2639 / SA-547 isProtectedTenant = paying ∨ (Stripe-linked ∧ not deleted)", () => {
  const active = { status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
  it("a paying tenant is protected on the 'paying' arm", () => {
    expect(lib.protectedArm(active, { planKey: "STARTER" }, NONE)).toBe("paying");
    expect(lib.isProtectedTenant(active, { planKey: "STARTER" }, NONE)).toBe(true);
  });
  it("the Stripe arm ALONE protects — TEST class, no planKey, not ACTIVE", () => {
    const t = { status: "READ_ONLY", class: "TEST", deletedAt: null };
    const sub = { planKey: null, stripeSubId: "sub_fake_qa" };
    expect(lib.protectedArm(t, sub, NONE)).toBe("stripe-linked");
    expect(lib.isProtectedTenant(t, sub, NONE)).toBe(true);
  });
  it("a soft-deleted Stripe-linked tenant is NOT protected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: new Date() };
    expect(lib.isProtectedTenant(t, { planKey: null, stripeSubId: "sub_fake_qa" }, NONE)).toBe(
      false,
    );
  });
  it("a non-paying, unlinked tenant (or no subscription row) is unprotected", () => {
    const t = { status: "ACTIVE", class: "TEST", deletedAt: null };
    expect(lib.protectedArm(t, { planKey: "STARTER", stripeSubId: null }, NONE)).toBeNull();
    expect(lib.protectedArm(t, null, NONE)).toBeNull();
    expect(lib.protectedArm(active, undefined, NONE)).toBeNull();
  });
});

describe("row 195 the env-listed arm (PROTECTED_TENANT_SLUGS)", () => {
  const LISTED = new Set(["acme-foods"]);
  const STATUSES = ["ACTIVE", "TRIAL", "READ_ONLY", "SUSPENDED", "CANCELLED", "PENDING_SETUP"];
  const CLASSES = ["PRODUCTION", "DEMO", "TEST", "INTERNAL"];
  const DELETED: Array<Date | null | undefined> = [null, undefined, new Date("2026-01-01")];

  it("the Set is REQUIRED: omitting it (or passing an array / string) throws, no env default", () => {
    const t = { slug: "acme-foods", status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    expect(() => lib.protectedArm(t, null)).toThrow(TypeError);
    expect(() => lib.protectedArm(t, null, ["acme-foods"])).toThrow(TypeError);
    expect(() => lib.isProtectedTenant(t, null, undefined)).toThrow(TypeError);
    const prev = process.env.PROTECTED_TENANT_SLUGS;
    process.env.PROTECTED_TENANT_SLUGS = "acme-foods";
    try {
      expect(() => lib.protectedArm(t, null)).toThrow(TypeError);
    } finally {
      if (prev === undefined) delete process.env.PROTECTED_TENANT_SLUGS;
      else process.env.PROTECTED_TENANT_SLUGS = prev;
    }
  });

  for (const status of STATUSES) {
    for (const cls of CLASSES) {
      for (const deletedAt of DELETED) {
        it(`a listed slug is protected: ${status} / ${cls} / deletedAt ${String(deletedAt && "set")}`, () => {
          const t = { slug: "acme-foods", status, class: cls, deletedAt: deletedAt as Date | null };
          // No subscription row at all: only the env arm can fire, and it ignores deletedAt.
          expect(lib.protectedArm(t, null, LISTED)).toBe("env-listed");
          // A tenant NOT on the list stays on the old two arms.
          expect(lib.protectedArm({ ...t, slug: "acme-deli" }, null, LISTED)).toBeNull();
        });
      }
    }
  }

  it("matches the trimmed, lower-cased slug", () => {
    const t = { slug: "  Acme-Foods ", status: "TRIAL", class: "PRODUCTION", deletedAt: null };
    expect(lib.protectedArm(t, null, LISTED)).toBe("env-listed");
  });

  it("a soft-deleted env-listed tenant is still protected", () => {
    const t = { slug: "acme-foods", status: "CANCELLED", class: "TEST", deletedAt: new Date() };
    expect(lib.isProtectedTenant(t, null, LISTED)).toBe(true);
  });

  it("paying and Stripe arms keep their names and win over env-listed", () => {
    const paying = { slug: "acme-foods", status: "ACTIVE", class: "PRODUCTION", deletedAt: null };
    expect(lib.protectedArm(paying, { planKey: "STARTER" }, LISTED)).toBe("paying");
    const trial = { slug: "acme-foods", status: "TRIAL", class: "PRODUCTION", deletedAt: null };
    expect(lib.protectedArm(trial, { planKey: null, stripeSubId: "sub_fake_qa" }, LISTED)).toBe(
      "stripe-linked",
    );
  });

  it("fails closed when slugs are listed but the row has no slug; an empty list never needs one", () => {
    const noSlug = { status: "TRIAL", class: "PRODUCTION", deletedAt: null };
    expect(() => lib.protectedArm(noSlug, null, LISTED)).toThrow(/slug/);
    expect(lib.protectedArm(noSlug, null, NONE)).toBeNull();
  });
});
