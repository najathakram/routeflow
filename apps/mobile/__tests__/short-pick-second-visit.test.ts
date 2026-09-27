/**
 * B785/SA-116 (mobile half) + SA-367a: on a SECOND visit the short-pick review offers only what
 * still remains — and "what remains" is the SERVER's per-line `remaining` (SA-366, the same value
 * the completion bound accepts up to), never `qty − deliveredSoFar` derived here. A Case line's
 * stepper ceiling is `floor(remaining / unitsPerBox)` plus the true remainder, and the payload
 * still carries an EXPLICIT entry per completed line. With NO served remaining (an older api) the
 * stepper is EMPTY: the driver must enter the line, and nothing is sent until they do.
 */
import {
  buildStopDeliveries,
  deliveredSoFarByLine,
  fallbackShortPickLines,
  isLineAdjustable,
  linesAwaitingEntry,
  normalizeDeliveryPlan,
  reconciledTotal,
  remainingByLine,
  shortPickLinesFromOrder,
} from "../lib/short-pick";
import { shortPickCategoryTax } from "../lib/run-money";
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
  // The run read serves both: remaining (quantities) and deliveredSoFar (display money only).
  const remaining = { "li-case": 36 };
  const soFar = { "li-case": 24 };

  it("is offered at the SERVED remaining: ceiling = 3 Cases (36 pieces)", () => {
    const [line] = shortPickLinesFromOrder(order, remaining, soFar);
    expect(line!.orderedQty).toBe(36);
    expect(line!.boxes).toBe(3);
    expect(line!.pieces).toBe(0);
    expect(line!.unitsPerBox).toBe(12);
    expect(line!.needsEntry).toBeUndefined();
  });

  it("SA-367a: every quantity comes from the server's remaining, never qty − deliveredSoFar", () => {
    // qty − soFar would be 36; the server says 12 (e.g. a concurrent visit). The client obeys it.
    const [line] = shortPickLinesFromOrder(order, { "li-case": 12 }, soFar);
    expect(line!.orderedQty).toBe(12);
    expect(line!.boxes).toBe(1);
    expect(buildStopDeliveries([{ orderId: "o1", lines: [line!], deliveredQtyById: {} }])).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "DELIVERED", quantityDelivered: 12 },
    ]);
  });

  it("the stepper snap can never exceed the remaining Cases", () => {
    const lines = shortPickLinesFromOrder(order, remaining, soFar);
    expect(normalizeDeliveryPlan(lines, { "li-case": 60 })).toEqual({ "li-case": 36 });
    expect(normalizeDeliveryPlan(lines, { "li-case": 24 })).toEqual({ "li-case": 24 });
  });

  it("an untouched line still sends an EXPLICIT entry — the remaining, never omitted, never the full 60", () => {
    const lines = shortPickLinesFromOrder(order, remaining, soFar);
    expect(buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: {} }])).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "DELIVERED", quantityDelivered: 36 },
    ]);
  });

  it("a short second visit is PARTIAL against the remaining", () => {
    const lines = shortPickLinesFromOrder(order, remaining, soFar);
    expect(
      buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: { "li-case": 12 } }]),
    ).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "PARTIAL", quantityDelivered: 12 },
    ]);
  });

  it("the estimate is the agreed money for the remaining portion (3 of 5 Cases = $72)", () => {
    const lines = shortPickLinesFromOrder(order, remaining, soFar);
    expect(reconciledTotal(lines, {})).toBe(72);
  });
});

describe("first visit and settled lines", () => {
  it("a first visit (served remaining == qty) keeps the full count", () => {
    const [line] = shortPickLinesFromOrder(
      { lineItems: [{ ...caseLine, deliveredQty: 0 }] },
      { "li-case": 60 },
    );
    expect(line!.orderedQty).toBe(60);
    expect(line!.boxes).toBe(5);
    expect(line!.subtotal).toBe(120);
  });

  it("a line with served remaining 0 is not offered (fully delivered, or not ordered any more)", () => {
    expect(shortPickLinesFromOrder(order, { "li-case": 0 }, { "li-case": 60 })).toEqual([]);
    expect(isLineAdjustable(caseLine, 0)).toBe(false);
  });

  it("older api (no remaining): the pre-B785 rule — a line already delivered stays settled", () => {
    expect(shortPickLinesFromOrder(order, {})).toEqual([]);
    expect(isLineAdjustable(caseLine, undefined)).toBe(false);
  });

  it("a cancelled line is never offered, whatever the served remaining", () => {
    expect(isLineAdjustable({ ...caseLine, status: "CANCELLED" }, 24)).toBe(false);
  });
});

describe("SA-367a: no served remaining ⇒ an EMPTY stepper, never qty", () => {
  const fresh = { ...caseLine, deliveredQty: 0 };
  const lines = shortPickLinesFromOrder({ lineItems: [fresh] }, {});

  it("the line is offered but marked needsEntry, with qty only as the ceiling", () => {
    expect(lines).toHaveLength(1);
    expect(lines[0]!.needsEntry).toBe(true);
    expect(lines[0]!.orderedQty).toBe(60);
  });

  it("untouched, it defaults to nothing: absent from the plan, $0 estimate and $0 excise", () => {
    expect(normalizeDeliveryPlan(lines, {})).toEqual({});
    expect(reconciledTotal(lines, {})).toBe(0);
    expect(
      shortPickCategoryTax([{ id: "li-case", qty: 60, categoryTaxAmount: 6 } as any], lines, {}),
    ).toBe(0);
  });

  it("the payload fails closed until the driver enters it — never full, never REFUSED", () => {
    expect(linesAwaitingEntry(lines, {})).toEqual(["li-case"]);
    expect(() => buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: {} }])).toThrow(
      /Enter the delivered quantity/,
    );
    // The screens pass the NORMALIZED plan — an un-entered line must stay absent there too, or it
    // would slip through as a 0/REFUSED entry.
    expect(() =>
      buildStopDeliveries([
        { orderId: "o1", lines, deliveredQtyById: normalizeDeliveryPlan(lines, {}) },
      ]),
    ).toThrow(/Enter the delivered quantity/);
  });

  it("once entered, it sends exactly the driver's entry", () => {
    const plan = normalizeDeliveryPlan(lines, { "li-case": 24 });
    expect(linesAwaitingEntry(lines, { "li-case": 24 })).toEqual([]);
    expect(buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: plan }])).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "PARTIAL", quantityDelivered: 24 },
    ]);
    // An explicit 0 is the driver's own refusal — allowed.
    expect(
      buildStopDeliveries([
        { orderId: "o1", lines, deliveredQtyById: normalizeDeliveryPlan(lines, { "li-case": 0 }) },
      ]),
    ).toEqual([
      { orderItemId: "li-case", productId: "p-1", type: "REFUSED", quantityDelivered: 0 },
    ]);
  });
});

describe("un-landed-order fallback (the stop snapshot carries remaining itself)", () => {
  it("carries the SERVED remaining and drops a line with nothing left", () => {
    const out = fallbackShortPickLines({
      lineItems: [
        { id: "a", productId: "p", qty: 10, subtotal: 100, deliveredSoFar: 4, remaining: 6 },
        { id: "b", productId: "p", qty: 5, subtotal: 50, deliveredSoFar: 5, remaining: 0 },
        { id: "c", productId: "p", qty: 3, subtotal: 30, remaining: 3 },
      ],
    });
    expect(out.map((l) => [l.orderItemId, l.orderedQty, l.subtotal, l.needsEntry])).toEqual([
      ["a", 6, 60, undefined],
      ["c", 3, 30, undefined],
    ]);
  });

  it("a cancelled/draft order's line (served 0) is dropped, not sent", () => {
    const out = fallbackShortPickLines({
      lineItems: [
        { id: "a", productId: "p", status: "PENDING", qty: 10, subtotal: 100, remaining: 0 },
      ],
    });
    expect(out).toEqual([]);
  });

  it("older api (no remaining): needsEntry, so the close is blocked rather than re-claiming full", () => {
    const out = fallbackShortPickLines({
      lineItems: [{ id: "a", productId: "p", qty: 10, subtotal: 100, deliveredSoFar: 4 }],
    });
    expect(out[0]!.needsEntry).toBe(true);
    expect(() =>
      buildStopDeliveries([{ orderId: "o1", lines: out, deliveredQtyById: {} }]),
    ).toThrow();
  });
});

describe("remainingByLine / deliveredSoFarByLine", () => {
  it("remainingByLine keeps every served value (0 included) and leaves absent/null/garbage OUT", () => {
    expect(
      remainingByLine([
        {
          lineItems: [
            { id: "x", remaining: 7 },
            { id: "y", remaining: 0 },
            { id: "z" },
            { id: "n", remaining: null },
            { id: "g", remaining: "not a number" },
          ],
        },
        { lineItems: [{ id: "w", remaining: "3" }] },
      ]),
    ).toEqual({ x: 7, y: 0, w: 3 });
    expect(remainingByLine(undefined)).toEqual({});
  });

  it("deliveredSoFarByLine flattens the stop snapshot, keeping only lines delivered elsewhere", () => {
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

describe("SA-367b: the completion payload carries no client money", () => {
  it("each entry is exactly orderItemId/productId/type/quantityDelivered — no subtotal, no orderedQty", () => {
    const lines = shortPickLinesFromOrder(order, { "li-case": 36 }, { "li-case": 24 });
    const [entry] = buildStopDeliveries([{ orderId: "o1", lines, deliveredQtyById: {} }]);
    expect(Object.keys(entry!).sort()).toEqual([
      "orderItemId",
      "productId",
      "quantityDelivered",
      "type",
    ]);
  });
});

describe("wiring pins", () => {
  const root = join(__dirname, "..");
  const shortPick = readFileSync(
    join(root, "app/(driver)/route/stop/[stopId]/short-pick.tsx"),
    "utf8",
  );
  const payment = readFileSync(join(root, "app/(driver)/route/stop/[stopId]/payment.tsx"), "utf8");
  const lib = readFileSync(join(root, "lib/short-pick.ts"), "utf8");

  it("both screens feed the SAME served-remaining + soFar maps into shortPickLinesFromOrder", () => {
    for (const src of [shortPick, payment]) {
      expect(src).toMatch(/remainingByLine\(stop\?\.orders\)/);
      expect(src).toMatch(/deliveredSoFarByLine\(stop\?\.orders\)/);
      expect(src).toMatch(
        /shortPickLinesFromOrder\(\s*ordersById\[id\],\s*remainingById,\s*soFarById,?\s*\)/,
      );
    }
  });

  it("both screens gate on linesAwaitingEntry before continuing / closing", () => {
    expect(shortPick).toMatch(/linesAwaitingEntry\(shortPickLines, qtyById\)/);
    expect(payment).toMatch(/linesAwaitingEntry\(p\.lines, deliveredQtyById\)/);
  });

  it("SA-367a: no client derives qty − deliveredSoFar for a decision", () => {
    for (const src of [shortPick, payment, lib]) {
      expect(src).not.toMatch(/qty\)?\s*-\s*(soFar|Number\(li\.deliveredSoFar\))/);
    }
  });

  it("the Case stepper reads the per-visit count, not the full stored one", () => {
    expect(shortPick).toMatch(/const caseCount =\s*visit\?\.boxes \?\? li\.boxes/);
  });
});
