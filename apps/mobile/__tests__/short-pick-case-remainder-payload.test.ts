/**
 * SA-175 Opus re-review of #2060 @ c0f121b2b — FIX 6/7 fixed the stepper's own increment/
 * decrement math and boxes/pieces split, but `effectiveDeliveredQty` (lib/short-pick.ts, pre-
 * existing B648/SA-094a code, untouched by FIX 6) is the SEPARATE choke point every screen
 * actually sends through (`normalizeDeliveryPlan` → `reconciledTotal`/`buildStopDeliveries`,
 * short-pick.tsx:128, payment.tsx:230/392) — and it floored the delivered qty to the nearest
 * WHOLE Case BEFORE checking whether the value already reached the remaining amount, silently
 * dropping the partial-Case remainder:
 *  - 30 left of a 12-Case, driver never touches the row (untouched = full remaining, 30):
 *    floor(30/12)*12 = 24 → sent PARTIAL $48 of the true $60 due.
 *  - 5 left of a 12-Case, untouched (5): floor(5/12)*12 = 0 → sent REFUSED $0.
 *  - after pressing "−" then "+" back to the top, the driver is stuck at 24/0 — can never send
 *    the true 30/5 again, even though the stepper's OWN top-of-range value (`ordered`) is correct.
 *
 * These tests exercise the SAME path a screen does — build lines via `shortPickLinesFromOrder`,
 * then read the SENT quantity/money through `normalizeDeliveryPlan`/`reconciledTotal`/
 * `buildStopDeliveries` — never the pure stepper functions in isolation, which only prove the
 * math exists, not that a screen actually sends it.
 */
import {
  buildStopDeliveries,
  caseStepperDecrement,
  caseStepperIncrement,
  normalizeDeliveryPlan,
  reconciledTotal,
  shortPickLinesFromOrder,
} from "../lib/short-pick";
import { readFileSync } from "fs";
import { join } from "path";

// 5 Cases of 12 = 60 pieces, $120 for the whole line, 2 Cases (24) already delivered elsewhere.
const caseLine = {
  id: "li-case",
  productId: "p-1",
  status: "PENDING",
  qty: 60,
  deliveredQty: 24,
  subtotal: 120,
  boxes: 5,
  unitsPerBox: 12,
  unitLabel: "Case",
};

describe("an UNTOUCHED second-visit line sends the FULL remaining, never a floored-down Case boundary", () => {
  it("30 left of 12: untouched sends 30 (DELIVERED, $60), never 24 (PARTIAL, $48)", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [caseLine] },
      { "li-case": 30 },
      { "li-case": 30 },
    );
    const plan = normalizeDeliveryPlan([line!], {}); // never touched — no qtyById entry at all
    expect(plan["li-case"]).toBe(30);
    expect(plan["li-case"]).not.toBe(24);

    // Screens feed the NORMALIZED plan forward (payment.tsx:392's deliveredQtyById:
    // normalizedPlan), never the raw untouched qtyById — that's the step the old bug broke.
    const deliveries = buildStopDeliveries([
      { orderId: "o1", lines: [line!], deliveredQtyById: plan },
    ]);
    expect(deliveries).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "DELIVERED", quantityDelivered: 30 },
    ]);

    expect(reconciledTotal([line!], plan)).toBe(60);
    expect(reconciledTotal([line!], plan)).not.toBe(48);
  });

  it("5 left of 12: untouched sends 5 (DELIVERED), never 0 (REFUSED)", () => {
    const line5 = { ...caseLine, deliveredQty: 55 }; // soFar governs the remaining view below
    const [line] = shortPickLinesFromOrder(
      { lineItems: [line5] },
      { "li-case": 5 },
      { "li-case": 55 },
    );
    const plan = normalizeDeliveryPlan([line!], {});
    expect(plan["li-case"]).toBe(5);
    expect(plan["li-case"]).not.toBe(0);

    const deliveries = buildStopDeliveries([
      { orderId: "o1", lines: [line!], deliveredQtyById: plan },
    ]);
    expect(deliveries).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "DELIVERED", quantityDelivered: 5 },
    ]);
  });
});

describe("the driver can always get BACK to the full remaining after adjusting down", () => {
  it("30 left of 12: minus then plus-to-top lands back on 30 through the SAME plan a screen reads", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [caseLine] },
      { "li-case": 30 },
      { "li-case": 30 },
    );
    let qty = 30;
    qty = caseStepperDecrement(qty, line!.orderedQty, 12); // -> 24 (drop the partial Case)
    qty = caseStepperDecrement(qty, line!.orderedQty, 12); // -> 12
    qty = caseStepperIncrement(qty, line!.orderedQty, 12); // -> 24
    qty = caseStepperIncrement(qty, line!.orderedQty, 12); // -> back to the top: 30, not 24

    const plan = normalizeDeliveryPlan([line!], { "li-case": qty });
    expect(plan["li-case"]).toBe(30); // the OLD bug stuck this at 24 forever
    expect(reconciledTotal([line!], { "li-case": qty })).toBe(60);
  });

  it("5 left of 12: minus-to-refuse then plus-to-top lands back on 5, never stuck at 0", () => {
    const line5 = { ...caseLine, deliveredQty: 55 };
    const [line] = shortPickLinesFromOrder(
      { lineItems: [line5] },
      { "li-case": 5 },
      { "li-case": 55 },
    );
    let qty = 5;
    qty = caseStepperDecrement(qty, line!.orderedQty, 12); // -> 0 (refuse)
    qty = caseStepperIncrement(qty, line!.orderedQty, 12); // -> back to the top: 5, not stuck at 0

    const plan = normalizeDeliveryPlan([line!], { "li-case": qty });
    expect(plan["li-case"]).toBe(5);
  });
});

describe("an exact-multiple remainder is unaffected — the fix only changes the partial-Case case", () => {
  it("24 left of 12 (no remainder): untouched still sends 24, a whole-Case value behaves as before", () => {
    const line24 = { ...caseLine, deliveredQty: 36 };
    const [line] = shortPickLinesFromOrder(
      { lineItems: [line24] },
      { "li-case": 24 },
      { "li-case": 36 },
    );
    const plan = normalizeDeliveryPlan([line!], {});
    expect(plan["li-case"]).toBe(24);
  });

  it("a genuinely PARTIAL Case-aligned override (12 of 24) still floors correctly, not passed through", () => {
    const line24 = { ...caseLine, deliveredQty: 36 };
    const [line] = shortPickLinesFromOrder(
      { lineItems: [line24] },
      { "li-case": 24 },
      { "li-case": 36 },
    );
    // 13 is NOT the remaining (24) and NOT a whole Case multiple — must still floor to 12, exactly
    // the pre-existing behavior for a genuinely below-remaining, non-boundary value.
    const plan = normalizeDeliveryPlan([line!], { "li-case": 13 });
    expect(plan["li-case"]).toBe(12);
  });
});

describe("wiring pins", () => {
  const shortPick = readFileSync(
    join(__dirname, "..", "app/(driver)/route/stop/[stopId]/short-pick.tsx"),
    "utf8",
  );

  it("the Case-stepper label always names the Case count via formatCaseStepperSplit, never the zero-suppressing formatQtySplit", () => {
    expect(shortPick).toMatch(/formatCaseStepperSplit/);
    expect(shortPick).not.toMatch(/formatQtySplit/);
  });
});
