/**
 * B785/SA-116 (mobile half): on a SECOND visit the short-pick review offers only what still
 * remains. A Case line's stepper bound is `count − casesDeliveredSoFar`, and the payload still
 * carries an EXPLICIT entry per completed line (the server never fills an omitted line in as
 * "as ordered").
 */
import {
  buildStopDeliveries,
  deliveredSoFarByLine,
  fallbackShortPickLines,
  isLineAdjustable,
  normalizeDeliveryPlan,
  reconciledTotal,
  shortPickLinesFromOrder,
} from "../lib/short-pick";
import { readFileSync } from "fs";
import { join } from "path";

// 5 Cases of 12 = 60 pieces, $120 for the whole line.
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
const order = { lineItems: [caseLine] };

describe("second-visit Case line (2 of 5 Cases delivered at the first visit)", () => {
  const soFar = { "li-case": 24 };

  it("is offered at the REMAINING: bound = count − casesDeliveredSoFar = 3 Cases (36 pieces)", () => {
    const [line] = shortPickLinesFromOrder(order, soFar);
    expect(line!.orderedQty).toBe(36);
    expect(line!.boxes).toBe(3);
    expect(line!.unitsPerBox).toBe(12);
  });

  it("the stepper snap can never exceed the remaining Cases", () => {
    const lines = shortPickLinesFromOrder(order, soFar);
    expect(normalizeDeliveryPlan(lines, { "li-case": 60 })).toEqual({ "li-case": 36 });
    expect(normalizeDeliveryPlan(lines, { "li-case": 24 })).toEqual({ "li-case": 24 });
  });

  it("an untouched line still sends an EXPLICIT entry — the remaining, never omitted, never the full 60", () => {
    const lines = shortPickLinesFromOrder(order, soFar);
    expect(buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: {} }])).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "DELIVERED", quantityDelivered: 36 },
    ]);
  });

  it("a short second visit is PARTIAL against the remaining", () => {
    const lines = shortPickLinesFromOrder(order, soFar);
    expect(
      buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: { "li-case": 12 } }]),
    ).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "PARTIAL", quantityDelivered: 12 },
    ]);
  });

  it("the estimate is the agreed money for the remaining portion (3 of 5 Cases = $72)", () => {
    const lines = shortPickLinesFromOrder(order, soFar);
    expect(reconciledTotal(lines, {})).toBe(72);
  });
});

describe("first visit and settled lines are unchanged", () => {
  it("a first visit (no deliveredSoFar) keeps the full count", () => {
    const [line] = shortPickLinesFromOrder({ lineItems: [{ ...caseLine, deliveredQty: 0 }] });
    expect(line!.orderedQty).toBe(60);
    expect(line!.boxes).toBe(5);
    expect(line!.subtotal).toBe(120);
  });

  it("a line fully delivered at other visits is not offered", () => {
    expect(shortPickLinesFromOrder(order, { "li-case": 60 })).toEqual([]);
    expect(isLineAdjustable(caseLine, 60)).toBe(false);
  });

  it("a line whose only delivery is THIS stop's own (deliveredQty > 0, no other visit) stays settled", () => {
    expect(shortPickLinesFromOrder(order, {})).toEqual([]);
    expect(isLineAdjustable(caseLine, 0)).toBe(false);
  });

  it("a cancelled line is never offered", () => {
    expect(isLineAdjustable({ ...caseLine, status: "CANCELLED" }, 24)).toBe(false);
  });
});

describe("un-landed-order fallback on a later visit", () => {
  it("carries the REMAINING (not the full order) and drops a line with nothing left", () => {
    const out = fallbackShortPickLines({
      lineItems: [
        { id: "a", productId: "p", qty: 10, subtotal: 100, deliveredSoFar: 4 },
        { id: "b", productId: "p", qty: 5, subtotal: 50, deliveredSoFar: 5 },
        { id: "c", productId: "p", qty: 3, subtotal: 30 },
      ],
    });
    expect(out.map((l) => [l.orderItemId, l.orderedQty, l.subtotal])).toEqual([
      ["a", 6, 60],
      ["c", 3, 30],
    ]);
  });
});

describe("deliveredSoFarByLine", () => {
  it("flattens the stop snapshot, keeping only lines delivered elsewhere", () => {
    expect(
      deliveredSoFarByLine([
        {
          lineItems: [{ id: "x", deliveredSoFar: 7 }, { id: "y", deliveredSoFar: 0 }, { id: "z" }],
        },
        { lineItems: [{ id: "w", deliveredSoFar: "3" }] },
      ]),
    ).toEqual({ x: 7, w: 3 });
    expect(deliveredSoFarByLine(undefined)).toEqual({});
  });
});

describe("wiring pins", () => {
  const root = join(__dirname, "..");
  const shortPick = readFileSync(
    join(root, "app/(driver)/route/stop/[stopId]/short-pick.tsx"),
    "utf8",
  );
  const payment = readFileSync(join(root, "app/(driver)/route/stop/[stopId]/payment.tsx"), "utf8");

  it("both screens feed the SAME per-visit map into shortPickLinesFromOrder", () => {
    expect(shortPick).toMatch(/deliveredSoFarByLine\(stop\?\.orders\)/);
    expect(shortPick).toMatch(/shortPickLinesFromOrder\(ordersById\[id\],\s*soFarById\)/);
    expect(payment).toMatch(/deliveredSoFarByLine\(stop\?\.orders\)/);
    expect(payment).toMatch(/shortPickLinesFromOrder\(ordersById\[id\],\s*soFarById\)/);
  });

  it("the Case stepper reads the per-visit count, not the full stored one", () => {
    expect(shortPick).toMatch(/const caseCount =\s*visit\?\.boxes \?\? li\.boxes/);
  });
});
