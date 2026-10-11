import { COUNTER_TENDER_DISPLAY_ORDER, counterChange } from "./counter-change";

describe("counterChange (SA-749r2): the one change formula", () => {
  it("card 30 + cash handed 40 on a 50 total: the cash takes 20, change 20", () => {
    expect(counterChange({ total: 50, nonCashApplied: 30, tendered: 40 })).toEqual({
      cashApplied: 20,
      change: 20,
    });
  });

  it("card 30 + cash handed 50 on a 70 total: cash takes 40, change 10", () => {
    expect(counterChange({ total: 70, nonCashApplied: 30, tendered: 50 })).toEqual({
      cashApplied: 40,
      change: 10,
    });
  });

  it("one cash leg with no other method: change is tendered less total", () => {
    expect(counterChange({ total: 41.27, nonCashApplied: 0, tendered: 50 })).toEqual({
      cashApplied: 41.27,
      change: 8.73,
    });
  });

  it("exact cash is change 0, never negative", () => {
    expect(counterChange({ total: 41.27, nonCashApplied: 0, tendered: 41.27 }).change).toBe(0);
  });

  it("tendered below what cash must cover (a partial payment): change 0", () => {
    expect(counterChange({ total: 100, nonCashApplied: 0, tendered: 40 })).toEqual({
      cashApplied: 100,
      change: 0,
    });
  });

  it("non-cash above the total: cash applied clamps at 0 and ALL the cash goes back", () => {
    expect(counterChange({ total: 50, nonCashApplied: 60, tendered: 20 })).toEqual({
      cashApplied: 0,
      change: 20,
    });
  });

  it("rounds every step to the cent (no float noise)", () => {
    // 0.1 + 0.2 style noise: 10.1 - 0.3 - 9.8 must be exactly 0.0
    expect(counterChange({ total: 10.1, nonCashApplied: 0.1 + 0.2, tendered: 9.8 })).toEqual({
      cashApplied: 9.8,
      change: 0,
    });
    expect(counterChange({ total: 33.33, nonCashApplied: 11.11, tendered: 30.005 })).toEqual({
      cashApplied: 22.22,
      change: 7.79,
    });
  });
});

describe("COUNTER_TENDER_DISPLAY_ORDER", () => {
  it("lists non-cash methods first and CASH last (the order the server applies the legs)", () => {
    expect([...COUNTER_TENDER_DISPLAY_ORDER]).toEqual([
      "CARD",
      "CHECK",
      "OTHER",
      "STORE_CREDIT",
      "CASH",
    ]);
  });
});
