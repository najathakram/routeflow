// SA-736r (R17-2): `couponFull` = "the next recurring invoice is $0 because of discounts", computed from
// Stripe's upcoming-invoice preview. The predicate is pure; Stripe is never called here.
import {
  COUPON_SYNC_EXPAND,
  COUPON_SYNC_REQUEST,
  NO_COUPON,
  couponFullFromPreview,
  firstCouponOfSubscription,
  isInvoiceUpcomingNone,
} from "./coupon-unbilled";

const subLine = (amount: number, discounts: number[] = [], over: Record<string, unknown> = {}) => ({
  amount,
  discount_amounts: discounts.map((d, i) => ({ amount: d, discount: `di_${i}` })),
  parent: { type: "subscription_item_details", subscription_item_details: { proration: false } },
  ...over,
});
const preview = (
  lines: unknown[],
  totalDiscount: number | null,
  over: Record<string, unknown> = {},
) => ({
  lines: { has_more: false, data: lines },
  total_discount_amounts:
    totalDiscount == null ? [] : [{ amount: totalDiscount, discount: "di_0" }],
  ...over,
});

describe("couponFullFromPreview", () => {
  it("a 100% coupon: every recurring line discounted to 0 -> full", () => {
    expect(
      couponFullFromPreview(preview([subLine(9900, [9900]), subLine(2000, [2000])], 11900)),
    ).toBe(true);
  });

  it("amount_off >= price (the discount overshoots the line) -> full", () => {
    expect(couponFullFromPreview(preview([subLine(9900, [15000])], 15000))).toBe(true);
  });

  it("item-level discounts that zero EVERY item -> full", () => {
    expect(
      couponFullFromPreview(preview([subLine(9900, [9900]), subLine(2000, [2000])], 11900)),
    ).toBe(true);
  });

  it("a 50% coupon -> not full", () => {
    expect(couponFullFromPreview(preview([subLine(9900, [4950])], 4950))).toBe(false);
  });

  it("one line still bills (the discount zeroes only the plan) -> not full", () => {
    expect(couponFullFromPreview(preview([subLine(9900, [9900]), subLine(2000, [])], 9900))).toBe(
      false,
    );
  });

  it("a 50% coupon plus a credit grant that drives total/amount_due to 0 must NOT read as full (total is never read)", () => {
    const p = preview([subLine(9900, [4950])], 4950, {
      total: 0,
      amount_due: 0,
      ending_balance: -4950,
    });
    expect(couponFullFromPreview(p)).toBe(false);
  });

  it("negative proration lines are ignored: they cannot make a billing line look free", () => {
    const credit = subLine(-3000, [], {
      parent: { type: "subscription_item_details", subscription_item_details: { proration: true } },
    });
    expect(couponFullFromPreview(preview([subLine(9900, [4950]), credit], 4950))).toBe(false);
    // ...and a proration line does not count as a recurring line on its own
    expect(couponFullFromPreview(preview([credit], 100))).toBe(false);
  });

  it("no discount at all (sum of total_discount_amounts = 0) -> not full, even for a $0 plan", () => {
    expect(couponFullFromPreview(preview([subLine(0, [])], null))).toBe(false);
    expect(couponFullFromPreview(preview([subLine(0, [])], 0))).toBe(false);
  });

  it("needs >= 1 recurring subscription line; an invoice-item line is not one", () => {
    const item = {
      amount: 500,
      discount_amounts: [{ amount: 500 }],
      parent: { type: "invoice_item_details" },
    };
    expect(couponFullFromPreview(preview([item], 500))).toBe(false);
    expect(couponFullFromPreview(preview([], 500))).toBe(false);
  });

  it("a duration:once coupon is excluded naturally: the UPCOMING invoice no longer carries it", () => {
    expect(couponFullFromPreview(preview([subLine(9900, [])], null))).toBe(false);
  });

  it("fail-closed on a truncated preview (has_more): unseen lines could still bill", () => {
    const p = preview([subLine(9900, [9900])], 9900);
    p.lines.has_more = true;
    expect(couponFullFromPreview(p)).toBe(false);
  });

  it("garbage in, not-full out", () => {
    for (const bad of [null, undefined, {}, { lines: null }, { lines: { data: "x" } }]) {
      expect(couponFullFromPreview(bad)).toBe(false);
    }
    expect(couponFullFromPreview(preview([subLine(Number.NaN, [1])], 1))).toBe(false);
  });

  it("reads a pre-dahlia line shape too (line.type === subscription, line.proration)", () => {
    const old = {
      type: "subscription",
      amount: 9900,
      proration: false,
      discount_amounts: [{ amount: 9900 }],
    };
    expect(couponFullFromPreview(preview([old], 9900))).toBe(true);
    expect(couponFullFromPreview(preview([{ ...old, proration: true }], 9900))).toBe(false);
  });
});

describe("firstCouponOfSubscription", () => {
  it("takes the first expanded discount's coupon id and its end date (repeating coupons)", () => {
    const sub = {
      discounts: [
        { source: { type: "coupon", coupon: "cp_pilot" }, end: 1_800_000_000 },
        { source: { coupon: "cp_2" } },
      ],
    };
    expect(firstCouponOfSubscription(sub)).toEqual({
      couponId: "cp_pilot",
      endsAt: new Date(1_800_000_000 * 1000),
    });
  });

  it("an expanded Coupon object, a bare id string in discounts, or nothing", () => {
    expect(
      firstCouponOfSubscription({ discounts: [{ source: { coupon: { id: "cp_obj" } } }] }).couponId,
    ).toBe("cp_obj");
    expect(firstCouponOfSubscription({ discounts: ["di_unexpanded"] })).toEqual({
      couponId: null,
      endsAt: null,
    });
    expect(firstCouponOfSubscription({ discounts: [] })).toEqual({ couponId: null, endsAt: null });
    expect(firstCouponOfSubscription(null)).toEqual({ couponId: null, endsAt: null });
  });

  it("an endless coupon has no end date", () => {
    expect(
      firstCouponOfSubscription({ discounts: [{ source: { coupon: "cp" }, end: null }] }).endsAt,
    ).toBeNull();
  });
});

describe("constants", () => {
  it("only invoice_upcoming_none keeps the stored value", () => {
    expect(isInvoiceUpcomingNone({ code: "invoice_upcoming_none" })).toBe(true);
    for (const other of [{ code: "resource_missing" }, new Error("x"), null, undefined]) {
      expect(isInvoiceUpcomingNone(other)).toBe(false);
    }
  });

  it("both Stripe calls are capped (10 s, no SDK retries) and the expand path is pinned", () => {
    expect(COUPON_SYNC_REQUEST).toEqual({ timeoutMs: 10_000, maxNetworkRetries: 0 });
    expect([...COUPON_SYNC_EXPAND]).toEqual(["discounts"]);
    expect(NO_COUPON).toEqual({ full: false, couponId: null, endsAt: null });
  });
});
