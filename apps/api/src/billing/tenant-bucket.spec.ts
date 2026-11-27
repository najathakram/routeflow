import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TENANT_ATTENTION_VALUES,
  TENANT_BUCKET_VALUES,
  TENANT_CLASS_VALUES,
  TENANT_STATUS_VALUES,
} from "@routeflow/types";
import { isPayingRow } from "./mrr.service";
import { TRIAL_NOTICE_DAYS } from "./billing-status";
import {
  ADMIN_SET_REASON,
  PAYMENT_OVERDUE_REASON,
  STRIPE_CANCELLED_REASON,
  SUBSCRIPTION_CANCELLED_REASON,
} from "./dunning-config";
import {
  ATTENTION_SET,
  BUCKET_SET,
  READ_ONLY_REASON_BUCKET,
  TRIAL_CANCELLED_REASON,
  TRIAL_EXPIRED_REASON,
  classifyTenantBucket,
  type TenantBucketInput,
} from "./tenant-bucket";
import type { PayingPriceClass } from "./mrr.service";

/**
 * SA-1535 / W-1462 PR-1: one function says which business tab a business is under. The table rows are red on a wrong
 * bucket; the matrix, parity and pin rows are GUARDS (a new file cannot be red on master).
 */
const NOW = new Date("2026-11-26T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const inDays = (n: number) => new Date(NOW.getTime() + n * DAY);

type Sub = NonNullable<TenantBucketInput["subscription"]>;
const sub = (o: Partial<Sub> = {}): Sub => ({
  planKey: "GROWTH",
  couponFull: false,
  pastDueSince: null,
  needsReconcile: false,
  cancelAtPeriodEnd: false,
  stripeSubId: null,
  stripeCustomerId: null,
  catchupState: null,
  ...o,
});
const row = (o: Partial<TenantBucketInput> = {}): TenantBucketInput => ({
  slug: "acme-wholesale",
  class: "PRODUCTION",
  status: "ACTIVE",
  deletedAt: null,
  trialEndsAt: null,
  readOnlyReason: null,
  subscription: sub(),
  ...o,
});
const bucketOf = (o: Partial<TenantBucketInput>, pc: PayingPriceClass | null = null) =>
  classifyTenantBucket(row(o), pc, NOW).bucket;
const classify = (o: Partial<TenantBucketInput>, pc: PayingPriceClass | null = null) =>
  classifyTenantBucket(row(o), pc, NOW);

describe("classifyTenantBucket: the first-hit table (SA-1535 section 1)", () => {
  const cases: Array<[string, Partial<TenantBucketInput>, string, (PayingPriceClass | null)?]> = [
    ["1 TEST", { class: "TEST", slug: "qa-acme" }, "test_demo"],
    ["1 DEMO", { class: "DEMO", slug: "routeflow-demo" }, "test_demo"],
    [
      "1 deleted TEST stays test_demo",
      { class: "TEST", slug: "qa-acme", deletedAt: NOW },
      "test_demo",
    ],
    ["2 INTERNAL", { class: "INTERNAL", slug: "routeflow-hq" }, "internal"],
    ["3 class none of the four", { class: "PARTNER" }, "unknown"],
    ["4 PRODUCTION deleted (ACTIVE with a plan)", { deletedAt: NOW }, "closed"],
    ["4 PRODUCTION CANCELLED", { status: "CANCELLED" }, "closed"],
    ["5 READ_ONLY, no reason (legacy)", { status: "READ_ONLY" }, "paused"],
    [
      "5 READ_ONLY payment_overdue",
      { status: "READ_ONLY", readOnlyReason: PAYMENT_OVERDUE_REASON },
      "paused",
    ],
    ["5 READ_ONLY admin_set", { status: "READ_ONLY", readOnlyReason: ADMIN_SET_REASON }, "paused"],
    [
      "5 READ_ONLY a reason nobody mapped",
      { status: "READ_ONLY", readOnlyReason: "mystery" },
      "paused",
    ],
    [
      "5 READ_ONLY subscription_cancelled",
      { status: "READ_ONLY", readOnlyReason: SUBSCRIPTION_CANCELLED_REASON },
      "closed",
    ],
    [
      "5 READ_ONLY stripe_cancelled",
      { status: "READ_ONLY", readOnlyReason: STRIPE_CANCELLED_REASON },
      "closed",
    ],
    [
      "5 READ_ONLY trial_cancelled",
      { status: "READ_ONLY", readOnlyReason: TRIAL_CANCELLED_REASON },
      "closed",
    ],
    [
      "5 READ_ONLY trial_expired",
      { status: "READ_ONLY", readOnlyReason: TRIAL_EXPIRED_REASON },
      "trial",
    ],
    [
      "5 SUSPENDED, any reason",
      { status: "SUSPENDED", readOnlyReason: "overdue_suspended" },
      "paused",
    ],
    ["5 SUSPENDED, no reason", { status: "SUSPENDED" }, "paused"],
    [
      "5 SUSPENDED with a cancelled reason is still paused",
      { status: "SUSPENDED", readOnlyReason: SUBSCRIPTION_CANCELLED_REASON },
      "paused",
    ],
    [
      "5 a deleted READ_ONLY PRODUCTION row is closed, not paused",
      { status: "READ_ONLY", deletedAt: NOW },
      "closed",
    ],
    ["6 PRODUCTION TRIAL", { status: "TRIAL", trialEndsAt: inDays(20) }, "trial"],
    ["7 PRODUCTION ACTIVE, paying set, priced above 0 (priceClass paying)", {}, "paying", "paying"],
    [
      "8 PRODUCTION ACTIVE, paying set but no price snapshot (unpriced)",
      {},
      "not_billed",
      "unpriced",
    ],
    [
      "8 PRODUCTION ACTIVE, paying set but nets to 0 (zero_priced)",
      {},
      "not_billed",
      "zero_priced",
    ],
    [
      "8 isPayingRow true but the caller passed no price class: never paying",
      {},
      "not_billed",
      null,
    ],
    ["8 PRODUCTION ACTIVE, no subscription", { subscription: null }, "not_billed"],
    ["8 PRODUCTION ACTIVE, no plan", { subscription: sub({ planKey: null }) }, "not_billed"],
    ["8 PRODUCTION ACTIVE, full coupon", { subscription: sub({ couponFull: true }) }, "not_billed"],
    ["9 PRODUCTION, a status nobody knows", { status: "ARCHIVED" }, "unknown"],
  ];
  // every row padded to four cells: a three-cell row would make jest read the fourth parameter as a done callback
  const rows = cases.map((c) => [c[0], c[1], c[2], c[3] ?? null] as const);
  it.each(rows)("%s", (_name, over, expected, pc) => {
    expect(bucketOf(over, pc)).toBe(expected);
  });

  it("READ_ONLY_REASON_BUCKET has a row for every lock reason the code writes (exhaustive; keyed by the dunning-config constants)", () => {
    expect(Object.keys(READ_ONLY_REASON_BUCKET).sort()).toEqual(
      [
        PAYMENT_OVERDUE_REASON,
        ADMIN_SET_REASON,
        SUBSCRIPTION_CANCELLED_REASON,
        STRIPE_CANCELLED_REASON,
        TRIAL_CANCELLED_REASON,
        TRIAL_EXPIRED_REASON,
      ].sort(),
    );
    expect(TRIAL_EXPIRED_REASON).toBe("trial_expired");
    expect(TRIAL_CANCELLED_REASON).toBe("trial_cancelled");
  });

  it("READ_ONLY attention (B3): overdue / trial_ended / unknown follow the reason", () => {
    const ro = (readOnlyReason: string | null, extra: Partial<TenantBucketInput> = {}) =>
      classify({ status: "READ_ONLY", readOnlyReason, ...extra }).attention;
    expect(ro(PAYMENT_OVERDUE_REASON)).toEqual(["overdue"]);
    expect(ro(ADMIN_SET_REASON)).toEqual([]);
    expect(ro(null)).toEqual([]);
    expect(ro("mystery")).toEqual(["unknown"]);
    expect(ro(SUBSCRIPTION_CANCELLED_REASON)).toEqual([]);
    expect(ro(SUBSCRIPTION_CANCELLED_REASON, { subscription: sub({ pastDueSince: NOW }) })).toEqual(
      ["overdue"],
    );
    expect(ro(STRIPE_CANCELLED_REASON, { subscription: sub({ pastDueSince: NOW }) })).toEqual([
      "overdue",
    ]);
    expect(ro(TRIAL_CANCELLED_REASON)).toEqual([]);
    expect(ro(TRIAL_EXPIRED_REASON)).toEqual(["trial_ended"]);
    expect(
      classify({ status: "SUSPENDED", subscription: sub({ pastDueSince: NOW }) }).attention,
    ).toEqual(["overdue"]);
    expect(classify({ status: "SUSPENDED" }).attention).toEqual([]);
  });

  it("unknown is only for a value outside the enums: every real class and status has a non-unknown bucket", () => {
    for (const klass of TENANT_CLASS_VALUES)
      for (const status of TENANT_STATUS_VALUES)
        expect(bucketOf({ class: klass, status }, "paying")).not.toBe("unknown");
  });

  it("a paying business in dunning stays in paying and carries overdue (the count stays tied to revenue)", () => {
    const r = classify({ subscription: sub({ pastDueSince: NOW }) }, "paying");
    expect(r.bucket).toBe("paying");
    expect(r.attention).toEqual(["overdue"]);
  });
});

describe("classifyTenantBucket: matrix and parity (GUARD)", () => {
  const classes = [...TENANT_CLASS_VALUES, "PARTNER"];
  const statuses = [...TENANT_STATUS_VALUES, "ARCHIVED"];
  const deleted = [null, NOW];
  const subs: Array<Sub | null> = [null, sub({ planKey: null }), sub(), sub({ couponFull: true })];

  it("every cell has one known bucket; paying implies isPayingRow; isPayingRow implies paying, or not_billed with subscribed_zero", () => {
    let cells = 0;
    for (const klass of classes)
      for (const status of statuses)
        for (const deletedAt of deleted)
          for (const s of subs) {
            const r = row({ class: klass, status, deletedAt, subscription: s });
            const candidate = isPayingRow(r, s?.planKey ?? null, s?.couponFull ?? false);
            const pcs: Array<PayingPriceClass | null> = candidate
              ? ["paying", "unpriced", "zero_priced"]
              : [null];
            for (const pc of pcs) {
              const out = classifyTenantBucket(r, pc, NOW);
              expect(TENANT_BUCKET_VALUES).toContain(out.bucket);
              if (out.bucket === "paying") expect(candidate).toBe(true);
              if (candidate && pc === "paying") expect(out.bucket).toBe("paying");
              if (candidate && pc !== "paying") {
                expect(out.bucket).toBe("not_billed");
                expect(out.attention).toContain("subscribed_zero");
              }
              cells += 1;
            }
          }
    expect(cells).toBeGreaterThan(classes.length * statuses.length);
  });

  it("the local bucket and attention sets equal the shared lists", () => {
    expect(Object.keys(BUCKET_SET).sort()).toEqual([...TENANT_BUCKET_VALUES].sort());
    expect(Object.keys(ATTENTION_SET).sort()).toEqual([...TENANT_ATTENTION_VALUES].sort());
  });

  it("source pin: one isPayingRow call and no paying comparison of its own", () => {
    const src = readFileSync(join(__dirname, "tenant-bucket.ts"), "utf8");
    expect((src.match(/isPayingRow\(/g) ?? []).length).toBe(1);
    expect(src).not.toMatch(/planKey\s*(==|!=)/);
    expect(src).not.toMatch(/couponFull\s*(===|!==|==|!=)/);
  });
});

describe("classifyTenantBucket: attention overlay and trial days", () => {
  const att = (o: Partial<TenantBucketInput>) => classify(o).attention;
  const days = (o: Partial<TenantBucketInput>) => classify(o).trialDaysLeft;

  it("trial_ending uses the notice window (7 days), inclusive", () => {
    expect(TRIAL_NOTICE_DAYS).toBe(7);
    expect(att({ status: "TRIAL", trialEndsAt: inDays(7) })).toEqual(["trial_ending"]);
    expect(att({ status: "TRIAL", trialEndsAt: inDays(8) })).toEqual([]);
  });

  it("trial_ended: a TRIAL past its end, or locked with reason trial_expired", () => {
    expect(att({ status: "TRIAL", trialEndsAt: inDays(-1) })).toEqual(["trial_ended"]);
    expect(
      att({ status: "READ_ONLY", readOnlyReason: "trial_expired", trialEndsAt: inDays(-3) }),
    ).toEqual(["trial_ended"]);
    expect(att({ status: "READ_ONLY", readOnlyReason: ADMIN_SET_REASON })).toEqual([]);
  });

  it("trial_no_end: a TRIAL with no end date", () => {
    expect(att({ status: "TRIAL", trialEndsAt: null })).toEqual(["trial_no_end"]);
  });

  it("needs_reconcile, cancelling and overdue come from the subscription", () => {
    expect(att({ subscription: sub({ needsReconcile: true }) })).toEqual(["needs_reconcile"]);
    expect(att({ subscription: sub({ cancelAtPeriodEnd: true }) })).toEqual(["cancelling"]);
    expect(att({ subscription: sub({ pastDueSince: NOW }) })).toEqual(["overdue"]);
  });

  it("class_slug_mismatch fires for a test-pattern slug classed PRODUCTION", () => {
    expect(
      att({ class: "PRODUCTION", slug: "qa-acme", status: "TRIAL", trialEndsAt: inDays(30) }),
    ).toEqual(["class_slug_mismatch"]);
    expect(att({ class: "PRODUCTION", slug: "e2e-routeflow" })).toContain("class_slug_mismatch");
  });

  it("class_slug_mismatch NEVER fires for an ordinary slug classed TEST, DEMO or INTERNAL (the reverse asserts no reason)", () => {
    expect(att({ class: "TEST", slug: "acme-wholesale" })).toEqual([]);
    expect(att({ class: "DEMO", slug: "acme-showroom" })).toEqual([]);
    expect(att({ class: "INTERNAL", slug: "acme-hq" })).toEqual([]);
    expect(att({ class: "TEST", slug: "e2e-acme" })).toEqual([]);
  });

  it("subscribed_zero: only when the paying set priced the row at 0 or with no snapshot; billed_not_production: a live card on a non-production class", () => {
    expect(classify({}, "unpriced").attention).toContain("subscribed_zero");
    expect(classify({}, "zero_priced").attention).toContain("subscribed_zero");
    expect(classify({}, "paying").attention).not.toContain("subscribed_zero");
    const live = { stripeSubId: "sub_acme" };
    expect(att({ class: "TEST", slug: "qa-acme", subscription: sub(live) })).toContain(
      "billed_not_production",
    );
    expect(
      att({
        class: "TEST",
        slug: "qa-acme",
        subscription: sub({ ...live, cancelAtPeriodEnd: true }),
      }),
    ).not.toContain("billed_not_production");
    expect(
      att({ class: "TEST", slug: "qa-acme", status: "CANCELLED", subscription: sub(live) }),
    ).not.toContain("billed_not_production");
    expect(att({ subscription: sub(live) })).not.toContain("billed_not_production");
  });

  it("overdue reads pastDueSince, nothing else", () => {
    expect(att({ subscription: sub({ pastDueSince: null }) })).toEqual([]);
  });

  it("an unknown bucket carries the unknown reason", () => {
    expect(att({ class: "PARTNER" })).toContain("unknown");
  });

  it("trialDaysLeft: whole days rounded up, never negative, for a TRIAL; null otherwise", () => {
    expect(days({ status: "TRIAL", trialEndsAt: inDays(5) })).toBe(5);
    expect(days({ status: "TRIAL", trialEndsAt: new Date(NOW.getTime() + 5 * DAY + 1000) })).toBe(
      6,
    );
    expect(days({ status: "TRIAL", trialEndsAt: inDays(-2) })).toBe(0);
    expect(days({ status: "TRIAL", trialEndsAt: null })).toBeNull();
    expect(days({ status: "ACTIVE", trialEndsAt: inDays(5) })).toBeNull();
  });
});

describe("billed_not_production reads cardBillingState === live (SA-1545 C5.3)", () => {
  const live = { stripeSubId: "sub_acme" };
  const att = (o: Partial<TenantBucketInput>) => classify(o).attention;
  it("a TEST business with a live card is flagged; uncertain (a customer only) is not", () => {
    expect(att({ class: "TEST", slug: "qa-acme", subscription: sub(live) })).toContain(
      "billed_not_production",
    );
    expect(
      att({ class: "TEST", slug: "qa-acme", subscription: sub({ stripeCustomerId: "cus_acme" }) }),
    ).not.toContain("billed_not_production");
    expect(
      att({
        class: "TEST",
        slug: "qa-acme",
        subscription: sub({ ...live, cancelAtPeriodEnd: true }),
      }),
    ).not.toContain("billed_not_production");
    expect(
      att({
        class: "TEST",
        slug: "qa-acme",
        status: "READ_ONLY",
        readOnlyReason: SUBSCRIPTION_CANCELLED_REASON,
        subscription: sub(live),
      }),
    ).not.toContain("billed_not_production");
  });
  it("a PRODUCTION business is never flagged, however live", () => {
    expect(att({ subscription: sub(live) })).not.toContain("billed_not_production");
  });
});
