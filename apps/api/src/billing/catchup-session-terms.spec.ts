import { buildCatchupSessionParams, catchupTermsSignature } from "./catchup-session-params";
import {
  checkSessionTerms,
  expectedSessionTerms,
  sameInstant,
  type ExpectedTermsInput,
} from "./catchup-session-terms";

/**
 * Row 542d / SA-800c: ONE pure answer to "was the stored Checkout session built with the terms the fresh plan would
 * build now?". match -> reuse; mismatch -> stale (expire it); unknown (a field or the signature missing or
 * unreadable) -> never guess. The signature is computed by the session builder itself from the params it sends to
 * Stripe, and the expected one is computed by the SAME builder from the fresh plan, so the two cannot drift.
 */
const S = new Date("2026-11-01T12:00:00Z");
const A = new Date("2026-12-01T12:00:00Z");
const NOW = new Date("2026-10-29T11:00:00Z");

const planOf = (
  shape: "trial_one_time" | "trial",
  totalCents: number,
  from: Date,
  to: Date,
  belowStripeMinimum = false,
) =>
  ({
    ok: true as const,
    now: NOW,
    shape,
    trialEndAt: to,
    termsHoldUntil: new Date(to.getTime() - 72 * 3600_000),
    stub: { from, to, label: "stub", lines: [], totalCents, belowStripeMinimum },
  }) as any;

const priceData = (cents: number) => ({
  currency: "usd",
  unit_amount: cents,
  recurring: { interval: "month" },
  product_data: { name: "RouteFlow Growth" },
});
const ADDON = {
  price_data: { ...priceData(2500), product_data: { name: "Scan" } },
  quantity: 1,
};

function input(over: Partial<ExpectedTermsInput> = {}): ExpectedTermsInput {
  return {
    tenantId: "t1",
    slug: "qa-acme",
    planKey: "GROWTH",
    planPriceData: priceData(31000),
    addonLines: [],
    addonSkus: [],
    plan: planOf("trial_one_time", 31000, S, A),
    now: NOW,
    ...over,
  };
}

const build = (i: ExpectedTermsInput, extra: Record<string, unknown> = {}) =>
  buildCatchupSessionParams({
    customerId: "cus_1",
    successUrl: "https://app.test/ok",
    cancelUrl: "https://app.test/no",
    ...i,
    ...extra,
  } as any);

const metaOf = (i: ExpectedTermsInput): Record<string, any> => build(i).metadata;

describe("sameInstant", () => {
  it("is the same instant in any ISO spelling; two nulls match; a null never matches an instant; junk never matches", () => {
    expect(sameInstant("2026-11-01T12:00:00.000Z", "2026-11-01T12:00:00+00:00")).toBe(true);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, "2026-11-01T12:00:00.000Z")).toBe(false);
    expect(sameInstant("soon", "soon")).toBe(false);
    expect(sameInstant("2026-11-01T12:00:00.000Z", "2026-11-01T12:00:01.000Z")).toBe(false);
  });
});

describe("(e) a session built by the real builder, compared with itself, is a match", () => {
  it.each([
    ["a stub bill", input()],
    ["a stub bill with an add-on", input({ addonLines: [ADDON], addonSkus: ["scan"] })],
    [
      "the stub-free trial shape",
      input({ plan: planOf("trial", 0, A, A), planPriceData: priceData(10000) }),
    ],
    ["a forgiven line", input({ plan: planOf("trial_one_time", 30, S, A, true) })],
  ])("%s", (_n, i) => {
    expect(checkSessionTerms(metaOf(i), expectedSessionTerms(i))).toBe("match");
  });

  it("the same instants in another ISO spelling still match", () => {
    const i = input();
    const m = { ...metaOf(i), catchup_to: "2026-12-01T12:00:00+00:00" };
    expect(checkSessionTerms(m, expectedSessionTerms(i))).toBe("match");
  });
});

describe("mismatch: the stored session was built with other terms than the fresh plan", () => {
  const stored = input();
  const stale = (fresh: ExpectedTermsInput) =>
    checkSessionTerms(metaOf(stored), expectedSessionTerms(fresh));

  it("(a) the recurring price changed ($310 -> $100) with every metadata term equal", () => {
    expect(stale(input({ planPriceData: priceData(10000) }))).toBe("mismatch");
  });

  it("(b) an add-on added, removed, re-quantified or swapped", () => {
    const withAddon = input({ addonLines: [ADDON], addonSkus: ["scan"] });
    expect(stale(withAddon)).toBe("mismatch");
    expect(checkSessionTerms(metaOf(withAddon), expectedSessionTerms(stored))).toBe("mismatch");
    expect(stale(input({ addonLines: [{ ...ADDON, quantity: 2 }], addonSkus: ["scan"] }))).toBe(
      "mismatch",
    );
    const other = {
      ...ADDON,
      price_data: { ...ADDON.price_data, product_data: { name: "Fleet" } },
    };
    expect(
      checkSessionTerms(metaOf(withAddon), expectedSessionTerms(input({ addonLines: [other] }))),
    ).toBe("mismatch");
  });

  it("(d) a forgiven line whose forgiven amount changed", () => {
    const forgiven = input({
      plan: planOf("trial_one_time", 30, S, A, true),
      planPriceData: priceData(30),
    });
    const changed = input({
      plan: planOf("trial_one_time", 40, S, A, true),
      planPriceData: priceData(30),
    });
    expect(checkSessionTerms(metaOf(forgiven), expectedSessionTerms(changed))).toBe("mismatch");
  });

  it("the trial end (A) moved: mismatch", () => {
    const next = new Date("2027-01-01T12:00:00Z");
    expect(stale(input({ plan: planOf("trial_one_time", 31000, S, next) }))).toBe("mismatch");
  });

  it.each([
    ["stub cents", { catchup_stub_cents: "40000" }],
    ["shape", { catchup_shape: "trial" }],
    ["catchup_to (A)", { catchup_to: "2026-11-01T12:00:00.000Z" }],
    ["catchup_from (S)", { catchup_from: "2026-10-01T12:00:00.000Z" }],
  ])("the metadata term the signature does not cover: %s", (_n, over) => {
    expect(checkSessionTerms({ ...metaOf(stored), ...over }, expectedSessionTerms(stored))).toBe(
      "mismatch",
    );
  });

  it("a signature that is not the fresh plan's (hand-edited) is a mismatch", () => {
    const m = { ...metaOf(stored), catchup_terms_sig: "0".repeat(64) };
    expect(checkSessionTerms(m, expectedSessionTerms(stored))).toBe("mismatch");
  });
});

describe("(f) unknown: never a guess", () => {
  const i = input();
  const expected = () => expectedSessionTerms(i);

  it.each([
    ["no metadata at all", undefined],
    ["null metadata", null],
    ["metadata that is not an object", "x"],
    ["metadata that is an array", [1]],
    ["an empty object", {}],
  ])("%s", (_n, meta) => {
    expect(checkSessionTerms(meta, expected())).toBe("unknown");
  });

  it.each([
    ["catchup_terms_sig", undefined],
    ["catchup_terms_sig", ""],
    ["catchup_terms_sig", "abc"],
    ["catchup_terms_sig", "G".repeat(64)],
    ["catchup_terms_sig", "A".repeat(64)],
    ["catchup_terms_sig", 5],
    ["catchup_stub_cents", undefined],
    ["catchup_stub_cents", "12.5"],
    ["catchup_stub_cents", "-1"],
    ["catchup_stub_cents", "1e3"],
    ["catchup_stub_cents", 31000],
    ["catchup_shape", undefined],
    ["catchup_shape", ""],
    ["catchup_from", undefined],
    ["catchup_from", "soon"],
    ["catchup_to", undefined],
    ["catchup_to", ""],
  ])("one field missing or unreadable: %s = %p", (key, value) => {
    const meta: Record<string, unknown> = { ...metaOf(i), [key]: value };
    if (value === undefined) delete meta[key];
    expect(checkSessionTerms(meta, expected())).toBe("unknown");
  });

  it("an unreadable field wins over a readable mismatch (nothing is decided on a half-read session)", () => {
    const meta = { ...metaOf(i), catchup_stub_cents: "0", catchup_to: "??" };
    expect(checkSessionTerms(meta, expected())).toBe("unknown");
    const noSig = { ...metaOf(i), catchup_stub_cents: "0" };
    delete (noSig as any).catchup_terms_sig;
    expect(checkSessionTerms(noSig, expected())).toBe("unknown");
  });
});

describe("(g) the signature covers the terms and nothing volatile", () => {
  const sigOf = (i: ExpectedTermsInput, extra: Record<string, unknown> = {}) =>
    build(i, extra).metadata.catchup_terms_sig as string;

  it("is a 64-character lower-case sha256 hex", () => {
    expect(sigOf(input())).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different success/cancel URLs, customer and `now` give the SAME signature", () => {
    const one = sigOf(input());
    const two = sigOf(input({ now: new Date("2026-10-20T08:15:30Z") }), {
      successUrl: "https://other.test/elsewhere?x=1",
      cancelUrl: "https://other.test/cancel",
      customerId: "cus_other",
    });
    expect(two).toBe(one);
  });

  it("the params that are sent carry the signature, computed from those same params (its own key and the other metadata are not signed)", () => {
    const params = build(input());
    expect(catchupTermsSignature({ ...params, metadata: {} })).toBe(
      params.metadata.catchup_terms_sig,
    );
    expect(catchupTermsSignature({ ...params, metadata: { anything: "else" } })).toBe(
      params.metadata.catchup_terms_sig,
    );
    expect(catchupTermsSignature({ ...params, expires_at: 1, success_url: "x" })).toBe(
      params.metadata.catchup_terms_sig,
    );
  });

  it("every charged term moves it: recurring price, an add-on, the one-time line, trial_end, quantity, mode, discounts", () => {
    const base = sigOf(input());
    const params = build(input());
    expect(sigOf(input({ planPriceData: priceData(10000) }))).not.toBe(base);
    expect(sigOf(input({ addonLines: [ADDON], addonSkus: ["scan"] }))).not.toBe(base);
    expect(sigOf(input({ plan: planOf("trial_one_time", 32000, S, A) }))).not.toBe(base);
    expect(
      sigOf(input({ plan: planOf("trial_one_time", 31000, S, new Date(A.getTime() + 1000)) })),
    ).not.toBe(base);
    expect(catchupTermsSignature({ ...params, mode: "payment" })).not.toBe(base);
    expect(catchupTermsSignature({ ...params, discounts: [{ coupon: "c" }] })).not.toBe(base);
    expect(
      catchupTermsSignature({
        ...params,
        line_items: [{ ...params.line_items[0], quantity: 2 }, ...params.line_items.slice(1)],
      }),
    ).not.toBe(base);
  });

  it("is independent of key order and ignores undefined values", () => {
    const params = build(input());
    const shuffled = {
      subscription_data: {
        trial_end: params.subscription_data.trial_end,
        metadata: { ignored: "yes" },
        proration_behavior: undefined,
      },
      line_items: params.line_items.map((l: any) => ({
        quantity: l.quantity,
        price_data: {
          product_data: l.price_data.product_data,
          unit_amount: l.price_data.unit_amount,
          currency: l.price_data.currency,
          ...(l.price_data.recurring ? { recurring: l.price_data.recurring } : {}),
        },
      })),
      payment_method_collection: params.payment_method_collection,
      mode: params.mode,
    };
    expect(catchupTermsSignature(shuffled)).toBe(params.metadata.catchup_terms_sig);
  });
});

describe("expectedSessionTerms", () => {
  it("carries the builder's own signature and the planner's charge-now cents, shape, S and A", () => {
    const i = input();
    expect(expectedSessionTerms(i)).toEqual({
      sig: build(i).metadata.catchup_terms_sig,
      stubCents: 31000,
      shape: "trial_one_time",
      from: S,
      to: A,
    });
  });

  it("a forgiven line is 0 cents (what the session carries), the stub-free trial shape is 0", () => {
    expect(
      expectedSessionTerms(input({ plan: planOf("trial_one_time", 30, S, A, true) })).stubCents,
    ).toBe(0);
    expect(expectedSessionTerms(input({ plan: planOf("trial", 0, A, A) })).stubCents).toBe(0);
  });
});
