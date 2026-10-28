import { completeAtCounterOffered, pickupHandOverOffered } from "./complete-at-counter";

/**
 * I-120 PR-2 (SA-861 rules 2-3, G7; the lead's rulings 2026-10-23): where "Complete at counter" is OFFERED. Web and mobile
 * both read this one rule.
 */
const base = { mayUseTill: true, methods: ["ROUTE", "SHIP", "PICKUP"], counter: "optional" };
const offered = (status: string, fulfillPath: string, over: object = {}) =>
  completeAtCounterOffered({ ...base, status, fulfillPath, ...over });

describe("completeAtCounterOffered", () => {
  it.each([
    ["PENDING", "ROUTE", true],
    ["PENDING", "SHIP", true],
    ["PENDING", "PICKUP", true], // no hand-over at PENDING yet
    ["CONFIRMED", "ROUTE", true],
    ["CONFIRMED", "SHIP", true],
    ["CONFIRMED", "PICKUP", false], // "Picked up" / "Hand over" is there
    ["OUT_FOR_DELIVERY", "PICKUP", false], // "Picked up" / "Hand over" is there
    ["DRAFT", "ROUTE", false],
    ["DELIVERED", "ROUTE", false],
    ["PARTIALLY_DELIVERED", "ROUTE", false],
    ["CANCELLED", "ROUTE", false],
  ])("%s on %s: %s", (status, path, want) => {
    expect(offered(status, path)).toBe(want);
  });

  it("one control per action: never offered where the pickup hand-over is", () => {
    for (const status of ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED"])
      for (const path of ["ROUTE", "SHIP", "PICKUP"])
        expect(offered(status, path) && pickupHandOverOffered(status, path)).toBe(false);
  });

  it("R9 (SA-913): shipped with the carrier is not offered, the api's COUNTER_COMPLETE_SHIPPED predicate", () => {
    expect(offered("CONFIRMED", "SHIP", { shippedAt: "2026-10-20T10:00:00Z" })).toBe(false);
    expect(offered("OUT_FOR_DELIVERY", "SHIP")).toBe(false);
    expect(offered("CONFIRMED", "SHIP", { shippedAt: null })).toBe(true);
  });

  it("R8 (SA-913): an order with a driver IS offered; the api asks to confirm taking it off the run", () => {
    expect(offered("OUT_FOR_DELIVERY", "ROUTE")).toBe(true);
    // the run never hides it now (the old 7a input is ignored, not read)
    expect(offered("CONFIRMED", "ROUTE", { runStatus: "IN_PROGRESS" } as object)).toBe(true);
  });

  it("a counter sale keeps the till", () => {
    expect(offered("PENDING", "PICKUP", { counterSale: true })).toBe(false);
  });

  it("no till permission, or a business that cannot hand over at the store: not offered", () => {
    expect(offered("PENDING", "ROUTE", { mayUseTill: false })).toBe(false);
    expect(offered("PENDING", "ROUTE", { methods: ["ROUTE"], counter: "off" })).toBe(false);
    expect(completeAtCounterOffered(null)).toBe(false);
  });
});
