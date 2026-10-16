import { buildCatchupSessionParams } from "./catchup-session-params";
import {
  checkSessionTerms,
  expectedSessionTerms,
  sameInstant,
  type ExpectedSessionTerms,
} from "./catchup-session-terms";

/**
 * Row 542d: ONE pure answer to "do the terms a stored Checkout session was built with equal the fresh plan's?".
 * match -> reuse the session; mismatch -> it is stale (expire it); unknown (a field missing or unreadable) -> never
 * guess. The session side is the metadata `buildCatchupSessionParams` writes, so the last block builds a real session
 * from a real-shaped plan and compares it with itself.
 */
const S = new Date("2026-11-01T12:00:00Z");
const A = new Date("2026-12-01T12:00:00Z");

const TERMS: ExpectedSessionTerms = { stubCents: 31000, shape: "trial_one_time", from: S, to: A };

const META = {
  catchup: "period",
  catchup_shape: "trial_one_time",
  catchup_stub_cents: "31000",
  catchup_from: S.toISOString(),
  catchup_to: A.toISOString(),
};

describe("sameInstant", () => {
  it("is the same instant in any ISO spelling; two nulls match; a null never matches an instant; junk never matches", () => {
    expect(sameInstant("2026-11-01T12:00:00.000Z", "2026-11-01T12:00:00+00:00")).toBe(true);
    expect(sameInstant(null, null)).toBe(true);
    expect(sameInstant(null, "2026-11-01T12:00:00.000Z")).toBe(false);
    expect(sameInstant("soon", "soon")).toBe(false);
    expect(sameInstant("2026-11-01T12:00:00.000Z", "2026-11-01T12:00:01.000Z")).toBe(false);
  });
});

describe("checkSessionTerms: match", () => {
  it("every field equal", () => {
    expect(checkSessionTerms(META, TERMS)).toBe("match");
  });

  it("the stub-free trial shape (S === A, $0 now)", () => {
    const meta = {
      ...META,
      catchup: "prepaid",
      catchup_shape: "trial",
      catchup_stub_cents: "0",
      catchup_from: A.toISOString(),
    };
    expect(checkSessionTerms(meta, { stubCents: 0, shape: "trial", from: A, to: A })).toBe("match");
  });

  it("a forgiven line: the session carries 0, the planner's charge-now is 0 (extra metadata is ignored)", () => {
    const meta = { ...META, catchup_stub_cents: "0", catchup_forgiven_cents: "30" };
    expect(checkSessionTerms(meta, { ...TERMS, stubCents: 0 })).toBe("match");
  });

  it("the same instant in another ISO spelling", () => {
    expect(checkSessionTerms({ ...META, catchup_to: "2026-12-01T12:00:00+00:00" }, TERMS)).toBe(
      "match",
    );
  });
});

describe("checkSessionTerms: mismatch (readable, but not the fresh plan's terms)", () => {
  it.each([
    ["stub cents differ", { catchup_stub_cents: "40000" }],
    ["the card add (0) against a one-time stub", { catchup_stub_cents: "0" }],
    ["shape differs", { catchup_shape: "trial" }],
    ["catchup_to (A) differs", { catchup_to: "2026-11-01T12:00:00.000Z" }],
    ["catchup_from (S) differs", { catchup_from: "2026-10-01T12:00:00.000Z" }],
  ])("%s", (_n, over) => {
    expect(checkSessionTerms({ ...META, ...over }, TERMS)).toBe("mismatch");
  });
});

describe("checkSessionTerms: unknown (never a guess)", () => {
  it.each([
    ["no metadata at all", undefined],
    ["null metadata", null],
    ["metadata that is not an object", "x"],
    ["metadata that is an array", [1]],
    ["an empty object", {}],
  ])("%s", (_n, meta) => {
    expect(checkSessionTerms(meta, TERMS)).toBe("unknown");
  });

  it.each([
    ["catchup_stub_cents", undefined],
    ["catchup_shape", undefined],
    ["catchup_from", undefined],
    ["catchup_to", undefined],
    ["catchup_stub_cents", ""],
    ["catchup_stub_cents", "12.5"],
    ["catchup_stub_cents", "-1"],
    ["catchup_stub_cents", "1e3"],
    ["catchup_stub_cents", "abc"],
    ["catchup_stub_cents", 31000],
    ["catchup_shape", ""],
    ["catchup_from", "soon"],
    ["catchup_to", "not a date"],
    ["catchup_to", ""],
  ])("one field missing or unreadable: %s = %p", (key, value) => {
    const meta: Record<string, unknown> = { ...META, [key]: value };
    if (value === undefined) delete meta[key];
    expect(checkSessionTerms(meta, TERMS)).toBe("unknown");
  });

  it("an unreadable field wins over a readable mismatch (nothing is decided on a half-read session)", () => {
    expect(checkSessionTerms({ ...META, catchup_stub_cents: "0", catchup_to: "??" }, TERMS)).toBe(
      "unknown",
    );
  });
});

describe("expectedSessionTerms: the planner's own terms", () => {
  const plan = (over: Record<string, unknown> = {}, stub: Record<string, unknown> = {}) =>
    ({
      ok: true,
      shape: "trial_one_time",
      trialEndAt: A,
      stub: {
        from: S,
        to: A,
        label: "November 2026 subscription",
        totalCents: 31000,
        belowStripeMinimum: false,
        ...stub,
      },
      ...over,
    }) as any;

  it("is what the session builder would write: charge-now cents, shape, S and A", () => {
    expect(expectedSessionTerms(plan())).toEqual(TERMS);
  });

  it("a forgiven line is 0 cents (what the session carries), not the forgiven total", () => {
    expect(expectedSessionTerms(plan({}, { totalCents: 30, belowStripeMinimum: true }))).toEqual({
      ...TERMS,
      stubCents: 0,
    });
  });

  it("the stub-free trial shape is 0 cents", () => {
    expect(
      expectedSessionTerms(plan({ shape: "trial" }, { from: A, to: A, totalCents: 0 })),
    ).toEqual({ stubCents: 0, shape: "trial", from: A, to: A });
  });
});

describe("a session built by the real builder matches the plan it was built from (and not a later plan)", () => {
  const base = (shape: "trial_one_time" | "trial", stubCents: number, from: Date, to: Date) => ({
    ok: true as const,
    now: new Date("2026-10-29T11:00:00Z"),
    shape,
    trialEndAt: to,
    termsHoldUntil: new Date(to.getTime() - 72 * 3600_000),
    stub: {
      from,
      to,
      label: "stub",
      lines: [],
      totalCents: stubCents,
      belowStripeMinimum: false,
    },
  });
  const build = (plan: any) =>
    buildCatchupSessionParams({
      tenantId: "t1",
      slug: "qa-acme",
      planKey: "GROWTH",
      customerId: "cus_1",
      planPriceData: { currency: "usd", unit_amount: 31000, recurring: { interval: "month" } },
      addonLines: [],
      addonSkus: [],
      plan,
      now: new Date("2026-10-29T11:00:00Z"),
      successUrl: "https://app.test/ok",
      cancelUrl: "https://app.test/no",
    });

  it("the card add (trial, $0) against itself is a match, against next month's stub a mismatch", () => {
    const cardAdd = base("trial", 0, S, S);
    const nextMonth = base("trial_one_time", 31000, S, A);
    const meta = build(cardAdd).metadata;
    expect(checkSessionTerms(meta, expectedSessionTerms(cardAdd as any))).toBe("match");
    expect(checkSessionTerms(meta, expectedSessionTerms(nextMonth as any))).toBe("mismatch");
  });

  it("a bill session against itself is a match, against a repriced stub a mismatch", () => {
    const bill = base("trial_one_time", 31000, S, A);
    const repriced = base("trial_one_time", 40000, S, A);
    const meta = build(bill).metadata;
    expect(checkSessionTerms(meta, expectedSessionTerms(bill as any))).toBe("match");
    expect(checkSessionTerms(meta, expectedSessionTerms(repriced as any))).toBe("mismatch");
  });
});
