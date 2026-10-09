import {
  centsToDollars,
  dollarsToCents,
  isWholeCents,
  TENDER_METHOD_VALUES,
  TENDER_RULES,
  TENDER_SURFACE_VALUES,
  planTenderLegs,
  type TenderLeg,
  type TenderMethod,
} from "./index";

/** Deep-freeze so any mutation by planTenderLegs throws (specs run in strict mode). */
const freeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    Object.values(v as object).forEach(freeze);
    Object.freeze(v);
  }
  return v;
};

const inv = (id: string, balanceCents: number) => ({ id, balanceCents });
const leg = (method: TenderMethod, amountCents: number) => ({ method, amountCents });

describe("tender vocabulary and rules (split payment)", () => {
  it("pins the method and surface lists", () => {
    expect([...TENDER_METHOD_VALUES]).toEqual([
      "CASH",
      "CARD",
      "CHECK",
      "ON_ACCOUNT",
      "STORE_CREDIT",
    ]);
    expect([...TENDER_SURFACE_VALUES]).toEqual(["counter"]);
  });

  it("TENDER_RULES has exactly one row per surface (exhaustive, no extras)", () => {
    expect(Object.keys(TENDER_RULES).sort()).toEqual([...TENDER_SURFACE_VALUES].sort());
    for (const surface of TENDER_SURFACE_VALUES) {
      const row = TENDER_RULES[surface];
      expect(row.maxLegs).toBeGreaterThanOrEqual(1);
      expect(row.maxCashLegs).toBeGreaterThanOrEqual(0);
      for (const m of row.allowed) expect(TENDER_METHOD_VALUES).toContain(m);
      for (const m of row.singleLegOnly) expect(row.allowed).toContain(m);
    }
  });

  it("the counter row: CASH/CARD/CHECK/ON_ACCOUNT, 4 legs, 1 cash leg, ON_ACCOUNT alone, no STORE_CREDIT", () => {
    const row = TENDER_RULES.counter;
    expect([...row.allowed]).toEqual(["CASH", "CARD", "CHECK", "ON_ACCOUNT"]);
    expect(row.maxLegs).toBe(4);
    expect(row.maxCashLegs).toBe(1);
    expect([...row.singleLegOnly]).toEqual(["ON_ACCOUNT"]);
    expect(row.allowed).not.toContain("STORE_CREDIT");
  });

  it("the counter group namespace is a FIXED literal: changing it re-keys every stored split sale", () => {
    expect(TENDER_RULES.counter.groupNamespace).toBe("a23aad82-7f3e-4540-a470-5476bbe31766");
  });
});

describe("planTenderLegs", () => {
  it("inv1 5000 / inv2 2000, card 3000 + cash 4000 -> card {inv1 3000}, cash {inv1 2000, inv2 2000}, change 0", () => {
    const out = planTenderLegs(
      [inv("inv1", 5000), inv("inv2", 2000)],
      [leg("CARD", 3000), leg("CASH", 4000)],
    );
    expect(out.placements).toEqual([
      { legIndex: 0, invoiceId: "inv1", amountCents: 3000 },
      { legIndex: 1, invoiceId: "inv1", amountCents: 2000 },
      { legIndex: 1, invoiceId: "inv2", amountCents: 2000 },
    ]);
    expect(out.changeCents).toBe(0);
    expect(out.refusedLegIndexes).toEqual([]);
  });

  it("non-cash legs are placed before cash regardless of request order; indexes stay the request's", () => {
    const out = planTenderLegs([inv("a", 7000)], [leg("CASH", 5000), leg("CARD", 3000)]);
    expect(out.placements).toEqual([
      { legIndex: 1, invoiceId: "a", amountCents: 3000 },
      { legIndex: 0, invoiceId: "a", amountCents: 4000 },
    ]);
    expect(out.changeCents).toBe(1000);
  });

  it("cash over the balance places only what is owed and reports the rest as change", () => {
    const out = planTenderLegs([inv("a", 7000)], [leg("CARD", 3000), leg("CASH", 5000)]);
    expect(out.placements.filter((p) => p.legIndex === 1)).toEqual([
      { legIndex: 1, invoiceId: "a", amountCents: 4000 },
    ]);
    expect(out.changeCents).toBe(1000);
  });

  it("short cash is placed as given with no change", () => {
    const out = planTenderLegs([inv("a", 7000)], [leg("CASH", 2500)]);
    expect(out.placements).toEqual([{ legIndex: 0, invoiceId: "a", amountCents: 2500 }]);
    expect(out.changeCents).toBe(0);
  });

  it("a non-cash leg that does not fit is refused WHOLE (nothing placed, later legs unaffected)", () => {
    const out = planTenderLegs(
      [inv("a", 5000)],
      [leg("CARD", 3000), leg("CHECK", 3000), leg("CASH", 2000)],
    );
    expect(out.refusedLegIndexes).toEqual([1]);
    expect(out.placements.filter((p) => p.legIndex === 1)).toEqual([]);
    expect(out.placements.filter((p) => p.legIndex === 2)).toEqual([
      { legIndex: 2, invoiceId: "a", amountCents: 2000 },
    ]);
  });

  it("a non-cash leg may span invoices oldest-first but is placed whole or not at all", () => {
    const out = planTenderLegs([inv("a", 1000), inv("b", 1000)], [leg("CARD", 1500)]);
    expect(out.placements).toEqual([
      { legIndex: 0, invoiceId: "a", amountCents: 1000 },
      { legIndex: 0, invoiceId: "b", amountCents: 500 },
    ]);
  });

  it("ON_ACCOUNT takes no money: no placement, never refused", () => {
    const out = planTenderLegs([inv("a", 1000)], [leg("ON_ACCOUNT", 0)]);
    expect(out).toEqual({ placements: [], changeCents: 0, refusedLegIndexes: [] });
  });

  it("zero-balance invoices are skipped; empty legs place nothing", () => {
    const out = planTenderLegs([inv("a", 0), inv("b", 900)], [leg("CARD", 900)]);
    expect(out.placements).toEqual([{ legIndex: 0, invoiceId: "b", amountCents: 900 }]);
    expect(planTenderLegs([inv("a", 900)], [])).toEqual({
      placements: [],
      changeCents: 0,
      refusedLegIndexes: [],
    });
  });

  it("never sorts or mutates its inputs (deep-frozen inputs do not throw; order is as given)", () => {
    const invoices = freeze([inv("late", 100), inv("early", 100)]);
    const legs: TenderLeg[] = freeze([leg("CARD", 150)]);
    const out = planTenderLegs(invoices, legs);
    expect(out.placements.map((p) => p.invoiceId)).toEqual(["late", "early"]);
    expect(invoices).toEqual([inv("late", 100), inv("early", 100)]);
    expect(legs).toEqual([leg("CARD", 150)]);
  });

  it("throws on a non-integer, negative, NaN or unsafe amount or balance", () => {
    for (const bad of [10.5, -1, Number.NaN, Infinity, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => planTenderLegs([inv("a", 1000)], [leg("CARD", bad)])).toThrow();
      expect(() => planTenderLegs([inv("a", bad)], [leg("CARD", 100)])).toThrow();
    }
  });
});

describe("dollarsToCents / centsToDollars", () => {
  it("round-trips EVERY cent from 0.00 to 1000.00 exactly (executed, not sampled)", () => {
    const bad: number[] = [];
    for (let c = 0; c <= 100_000; c++) {
      const d = centsToDollars(c);
      if (dollarsToCents(d) !== c || !isWholeCents(d)) bad.push(c);
    }
    expect(bad).toEqual([]);
    // the float-unsafe spellings: 19.99 * 100 is 1998.9999999999998
    expect(dollarsToCents(19.99)).toBe(1999);
    expect(dollarsToCents(1.1)).toBe(110);
    expect(dollarsToCents(0.29)).toBe(29);
  });

  it("refuses a sub-cent or non-finite dollar amount, and a non-integer or unsafe cent count", () => {
    for (const d of [1.005, 0.001, Number.NaN, Infinity]) expect(() => dollarsToCents(d)).toThrow();
    for (const c of [1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2])
      expect(() => centsToDollars(c)).toThrow();
  });
});
