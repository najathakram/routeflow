import { readFileSync } from "fs";
import { join } from "path";
import { completeAtCounterShown, completeAtCounterSheetCopy } from "../lib/pos-mode";

// I-120 PR-2 (SA-861 rules 1-3, G7; mirrors web): "Complete at counter" on the order screen. Shown by the ONE shared rule
// (`completeAtCounterOffered`, @routeflow/pricing) with the session's till permission (USE_POS_MODE) and the tenant's
// fulfilment capability; never beside the hand-over (same engine); held for OWNER-QUEUE 7a (R8/R9).
const features = (counter: string, methods: string[]) => ({
  capabilities: { fulfilment: { counter, methods } },
});
const order = (status: string, fulfillPath: string, over: object = {}) => ({
  status,
  fulfillPath,
  counterSale: false,
  shippedAt: null,
  ...over,
});
const caps = features("optional", ["ROUTE", "SHIP", "PICKUP"]);

describe("completeAtCounterShown (I-120 PR-2)", () => {
  it("an open delivery or ship order, for a till role: shown", () => {
    expect(completeAtCounterShown(order("PENDING", "ROUTE"), "OPERATOR", caps)).toBe(true);
    expect(completeAtCounterShown(order("CONFIRMED", "SHIP"), "TENANT_ADMIN", caps)).toBe(true);
  });

  it("never beside the pickup hand-over (one control per action)", () => {
    expect(completeAtCounterShown(order("CONFIRMED", "PICKUP"), "OPERATOR", caps)).toBe(false);
    expect(completeAtCounterShown(order("OUT_FOR_DELIVERY", "PICKUP"), "OPERATOR", caps)).toBe(
      false,
    );
  });

  it("OWNER-QUEUE 7a (R8/R9): not with a driver or carrier, nor once shipped", () => {
    expect(completeAtCounterShown(order("OUT_FOR_DELIVERY", "ROUTE"), "OPERATOR", caps)).toBe(
      false,
    );
    expect(
      completeAtCounterShown(
        order("CONFIRMED", "SHIP", { shippedAt: "2026-10-20T10:00:00Z" }),
        "OPERATOR",
        caps,
      ),
    ).toBe(false);
  });

  it("a role without the till, a business that cannot hand over at the store, an unknown answer: hidden", () => {
    expect(completeAtCounterShown(order("PENDING", "ROUTE"), "DRIVER", caps)).toBe(false);
    expect(
      completeAtCounterShown(order("PENDING", "ROUTE"), "OPERATOR", features("off", ["ROUTE"])),
    ).toBe(false);
    expect(completeAtCounterShown(order("PENDING", "ROUTE"), "OPERATOR", undefined)).toBe(false);
    expect(completeAtCounterShown(null, "OPERATOR", caps)).toBe(false);
  });

  it("the sheet's copy in complete mode", () => {
    expect(completeAtCounterSheetCopy(true)).toEqual({
      title: "Complete at counter",
      action: "Complete at counter",
    });
    expect(completeAtCounterSheetCopy(false)).toEqual({ title: "Hand over", action: "Hand over" });
  });
});

describe("order screen wiring (source-pinned: RN screens aren't renderable in this lane)", () => {
  const src = readFileSync(join(__dirname, "..", "app/(operator)/(tabs)/orders/[id].tsx"), "utf8");
  it("the button is gated by completeAtCounterShown and opens the hand-over sheet in complete mode", () => {
    expect(src).toMatch(/completeAtCounterShown\(order, staffRole, tenantFeatures\)/);
    expect(src).toMatch(/COUNTER_COPY\.completeAtCounter/);
    expect(src).toMatch(/setCompleteMode\(true\)/);
    expect(src).toMatch(
      /<PosHandOverSheet[\s\S]*?copy=\{completeAtCounterSheetCopy\(completeMode\)\}/,
    );
  });
});
