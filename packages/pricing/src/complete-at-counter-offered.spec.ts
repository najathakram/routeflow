import {
  COMPLETE_AT_COUNTER_AWAITS_OWNER_7A,
  completeAtCounterOffered,
  pickupHandOverOffered,
} from "./complete-at-counter";

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

  it("OWNER-QUEUE 7a (Q1/Q2, R8/R9) holds: an order with a driver or a carrier, and a shipped order, are not offered", () => {
    expect(COMPLETE_AT_COUNTER_AWAITS_OWNER_7A).toBe(true); // flip with the owner's answers, and update these cases
    expect(offered("OUT_FOR_DELIVERY", "ROUTE")).toBe(false); // R8 / Q1
    expect(offered("OUT_FOR_DELIVERY", "SHIP")).toBe(false); // R8 / Q1
    expect(offered("CONFIRMED", "SHIP", { shippedAt: "2026-10-20T10:00:00Z" })).toBe(false); // R9 / Q2
    expect(offered("CONFIRMED", "SHIP", { shippedAt: null })).toBe(true);
  });

  it("OWNER-QUEUE 7a (Q1), SA-905 LOW: an order on an ACTIVE run (SCHEDULED / IN_PROGRESS) is not offered", () => {
    expect(offered("PENDING", "ROUTE", { runStatus: "SCHEDULED" })).toBe(false);
    expect(offered("CONFIRMED", "ROUTE", { runStatus: "IN_PROGRESS" })).toBe(false);
    expect(offered("CONFIRMED", "ROUTE", { runStatus: "COMPLETED" })).toBe(true); // a finished run's link is released at the switch
    expect(offered("CONFIRMED", "ROUTE", { runStatus: null })).toBe(true);
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
