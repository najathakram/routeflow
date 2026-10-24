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

  it("R9 (SA-913): not with the carrier, nor once shipped", () => {
    expect(completeAtCounterShown(order("OUT_FOR_DELIVERY", "SHIP"), "OPERATOR", caps)).toBe(false);
    expect(
      completeAtCounterShown(
        order("CONFIRMED", "SHIP", { shippedAt: "2026-10-20T10:00:00Z" }),
        "OPERATOR",
        caps,
      ),
    ).toBe(false);
  });

  it("R8 (SA-913): with a driver, or on an active run: shown (the api asks to take it off the run)", () => {
    expect(completeAtCounterShown(order("OUT_FOR_DELIVERY", "ROUTE"), "OPERATOR", caps)).toBe(true);
    expect(
      completeAtCounterShown(
        order("PENDING", "ROUTE", { routeRun: { status: "IN_PROGRESS" } }),
        "OPERATOR",
        caps,
      ),
    ).toBe(true);
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

  it("SA-913 R8: a 409 COUNTER_COMPLETE_ON_RUN asks first, then re-sends the same body with takeOffRun", () => {
    expect(src).toMatch(
      /const runConfirm = pickupRunConfirm\(e\);[\s\S]*?onPress: \(\) => submitHandOver\(\{ \.\.\.body, takeOffRun: true \}\)/,
    );
  });
});

// #3689 review MUST 3: the complete-mode outcome says "Completed at counter", as web does, never "Handed over".
describe("decidePickupResponse in complete mode (I-120 PR-2)", () => {
  const { decidePickupResponse } = require("../lib/pos-mode");
  const res = (over: Record<string, unknown>) => ({
    orderId: "o",
    orderNumber: "1",
    invoiceId: "i",
    invoiceNumber: "I-1",
    total: 25,
    paid: 25,
    balanceDue: 0,
    paymentRecorded: true,
    ...over,
  });
  it("recorded and emailed: the emailed line", () => {
    expect(decidePickupResponse(res({ emailed: true }), "OPERATOR", "Acme", true).message).toBe(
      "Completed at counter. The invoice was emailed to the customer.",
    );
  });
  it("recorded, no email (a walk-in): the plain line", () => {
    expect(decidePickupResponse(res({}), "OPERATOR", "Acme", true).message).toBe(
      "Completed at counter.",
    );
  });
  it("the hand-over itself keeps its words", () => {
    expect(decidePickupResponse(res({}), "OPERATOR", "Acme").message).toBe("Handed over");
  });
});

// #3689 review MUST 4 + NIT (mirrors web): the refusals' own copy, "Nothing changed"; complete mode never says pickup.
describe("pickupCompleteErrorCopy: Complete at counter refusals (I-120, mobile)", () => {
  const { pickupCompleteErrorCopy } = require("../lib/pos-mode");
  const refusal = (data: Record<string, unknown>) => ({ response: { status: 409, data } });
  it("the four refusals", () => {
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_UNAVAILABLE" }))).toBe(
      "Nothing changed. This business doesn't hand orders over at the store.",
    );
    expect(
      pickupCompleteErrorCopy(refusal({ code: "CREDIT_LIMIT_EXCEEDED", limit: 50, exposure: 120 })),
    ).toBe(
      "This customer is over their credit limit ($120.00 of $50.00). Take payment now, or record a payment first.",
    );
    expect(pickupCompleteErrorCopy(refusal({ code: "SELLING_RESTRICTED" }))).toBe(
      "An item on this order can't be sold at the store. Edit the order, or deliver it.",
    );
    expect(pickupCompleteErrorCopy(refusal({ code: "ORDER_ON_ACTIVE_RUN" }))).toBe(
      "Nothing changed. This order is on an active delivery run. Remove it from the run first.",
    );
  });
  it("complete mode never says pickup", () => {
    expect(pickupCompleteErrorCopy(refusal({}), true)).toBe(
      "Couldn't complete the order. Check it and try again.",
    );
    expect(pickupCompleteErrorCopy(refusal({ code: "PICKUP_KEY_CONFLICT" }), true)).toBe(
      "Already completed. Record any payment on the invoice.",
    );
  });
  // W-818: mobile has no Counter sale screen (route-parity-manifest), so the hint never points to one. It says what the
  // switch does when it's on.
  it("the New order Store pickup hint says what the switch does, and names no screen mobile lacks", () => {
    const { POS_COPY } = require("../lib/pos-mode");
    expect(POS_COPY.switchHint).toBe(
      "Invoices a named customer now, and they pick the order up in store.",
    );
    expect(POS_COPY.switchHint).not.toMatch(/Counter sale/i);
  });
});

// I-120 R8/R9 (owner 7a), mirrors web.
describe("pickupCompleteErrorCopy: R8/R9 refusals (mobile)", () => {
  const { pickupCompleteErrorCopy } = require("../lib/pos-mode");
  const refusal = (data: Record<string, unknown>) => ({ response: { status: 409, data } });
  it("the three refusals", () => {
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_SHIPPED" }))).toBe(
      "Nothing changed. This order has shipped with the carrier.",
    );
    expect(
      pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_ON_RUN", driverName: "Sam" })),
    ).toBe("Nothing changed. This order is on Sam's run. Completing it here takes it off the run.");
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_STOP_STARTED" }))).toBe(
      "Nothing changed. The driver has started this stop. Finish it on the route.",
    );
  });
});

// SA-913 R8: the run confirm (mirrors web): a question naming the driver, its action re-sends with takeOffRun.
describe("pickupRunConfirm (mobile)", () => {
  const { pickupRunConfirm } = require("../lib/pos-mode");
  const refusal = (data: Record<string, unknown>) => ({ response: { status: 409, data } });
  it("COUNTER_COMPLETE_ON_RUN: the driver's name and the take-off action", () => {
    expect(
      pickupRunConfirm(refusal({ code: "COUNTER_COMPLETE_ON_RUN", driverName: "Sam" })),
    ).toEqual({
      title: "Complete at counter",
      message: "This order is on Sam's run. Completing it here takes it off the run.",
      action: "Take off run and complete",
    });
  });
  it("any other refusal is not a confirm", () => {
    expect(pickupRunConfirm(refusal({ code: "COUNTER_COMPLETE_STOP_STARTED" }))).toBeNull();
    expect(pickupRunConfirm(new Error("network"))).toBeNull();
  });
});
