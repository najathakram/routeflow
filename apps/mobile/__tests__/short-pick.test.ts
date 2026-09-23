import {
  deliveryTypeForQty,
  buildDeliveries,
  reconciledTotal,
  isFullyDelivered,
  isUnitAwareLine,
} from "../lib/short-pick";

const lines = [
  { orderItemId: "li-1", productId: "p-1", orderedQty: 10, subtotal: 100 }, // $10/unit
  { orderItemId: "li-2", productId: "p-2", orderedQty: 2, subtotal: 60 }, // $30/unit
];

describe("deliveryTypeForQty", () => {
  it("classifies full/partial/refused", () => {
    expect(deliveryTypeForQty(10, 10)).toBe("DELIVERED");
    expect(deliveryTypeForQty(6, 10)).toBe("PARTIAL");
    expect(deliveryTypeForQty(0, 10)).toBe("REFUSED");
  });
});

describe("buildDeliveries", () => {
  it("defaults untouched lines to the full ordered qty, DELIVERED", () => {
    expect(buildDeliveries(lines, {})).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", qty: 10 },
      { orderItemId: "li-2", productId: "p-2", type: "DELIVERED", qty: 2 },
    ]);
  });

  it("marks a short line PARTIAL at the reduced qty", () => {
    const out = buildDeliveries(lines, { "li-1": 7 });
    expect(out[0]).toEqual({ orderItemId: "li-1", productId: "p-1", type: "PARTIAL", qty: 7 });
  });

  it("marks a zeroed line REFUSED", () => {
    const out = buildDeliveries(lines, { "li-2": 0 });
    expect(out[1]).toEqual({ orderItemId: "li-2", productId: "p-2", type: "REFUSED", qty: 0 });
  });

  it("clamps an out-of-range override to the ordered qty", () => {
    const out = buildDeliveries(lines, { "li-1": 999 });
    expect(out[0]!.qty).toBe(10);
    expect(out[0]!.type).toBe("DELIVERED");
  });

  it("includes an unlisted (productId null) line — server keys on orderItemId, and it's charged by reconciledTotal", () => {
    // An all-unlisted order must still produce a non-empty deliveries array, or
    // payment.tsx's `deliveries.length === 0` guard blocks the stop; and the
    // charged reconciledTotal (which counts this line) must match a line the
    // server actually marks delivered.
    const unlisted = [{ orderItemId: "li-4", productId: null, orderedQty: 3, subtotal: 30 }];
    expect(buildDeliveries(unlisted, {})).toEqual([
      { orderItemId: "li-4", productId: null, type: "DELIVERED", qty: 3 },
    ]);
    expect(reconciledTotal(unlisted, {})).toBe(30);
  });
});

describe("reconciledTotal", () => {
  it("sums the full order when nothing is short (cent-parity with subtotal sum)", () => {
    expect(reconciledTotal(lines, {})).toBe(160);
  });

  it("prorates a short line by the SERVER's formula (subtotal * delivered / ordered)", () => {
    // li-1: 100 * 7/10 = 70; li-2 unchanged: 60. Total 130.
    expect(reconciledTotal(lines, { "li-1": 7 })).toBe(130);
  });

  it("a refused line contributes $0", () => {
    expect(reconciledTotal(lines, { "li-2": 0 })).toBe(100);
  });

  it("cent-parity for a boxed line's stored subtotal (not a fresh qty*unitPrice)", () => {
    // A boxed line's unitPrice is the BOX price; stored subtotal already accounts
    // for that. Delivering 1 of 2 boxes (qty 12 of 24 pieces) must prorate the
    // STORED subtotal, never recompute qty*unitPrice against the box unitPrice.
    const boxed = [{ orderItemId: "li-3", productId: "p-3", orderedQty: 24, subtotal: 48 }];
    expect(reconciledTotal(boxed, { "li-3": 12 })).toBe(24);
  });
});

describe("isFullyDelivered", () => {
  it("true when no overrides are present", () => {
    expect(isFullyDelivered(lines, {})).toBe(true);
  });
  it("false once any line is reduced", () => {
    expect(isFullyDelivered(lines, { "li-1": 5 })).toBe(false);
  });
});

// B648: a units_v1 line (unitLabel set — "Case", "Pallet"…) never supports a
// PARTIAL count — `orderedQty` there is base PIECES (count × the line's
// unitsPerBox snapshot), and a delivered qty other than a whole multiple of
// the case size has no physical meaning. It still supports the same binary
// DELIVERED/REFUSED choice every other line does — refusing partial is not
// the same as forcing full (a driver who could not deliver the Case must be
// able to record that, or the customer is billed for goods never delivered:
// the B663 class of bug).
describe("B648: a unit-aware line supports delivered/not-delivered, never a partial count", () => {
  const caseLine = {
    orderItemId: "li-case",
    productId: "p-case",
    orderedQty: 864, // 3 Cases of 288
    subtotal: 300,
    unitLabel: "Case",
  };

  it("isUnitAwareLine identifies it, and not a plain pack/piece line", () => {
    expect(isUnitAwareLine(caseLine)).toBe(true);
    expect(isUnitAwareLine({ unitLabel: null })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: undefined })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: "" })).toBe(false);
  });

  it("untouched (no entry) defaults to DELIVERED at the full ordered qty, same as every other line", () => {
    expect(buildDeliveries([caseLine], {})).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "DELIVERED", qty: 864 },
    ]);
    expect(reconciledTotal([caseLine], {})).toBe(300);
    expect(isFullyDelivered([caseLine], {})).toBe(true);
  });

  it("an explicit not-delivered (0) gives REFUSED at qty 0, and the reconciled total excludes the line", () => {
    expect(buildDeliveries([caseLine], { "li-case": 0 })).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "REFUSED", qty: 0 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 0 })).toBe(0);
    expect(isFullyDelivered([caseLine], { "li-case": 0 })).toBe(false);
  });

  it("an explicit delivered (full ordered qty) gives DELIVERED at the full amount", () => {
    expect(buildDeliveries([caseLine], { "li-case": 864 })).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "DELIVERED", qty: 864 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 864 })).toBe(300);
  });

  it("a stray partial piece count (e.g. a leftover value from before unit-awareness was known) still cannot leak into the math — resolves to the full amount, never the raw value or a prorated fraction", () => {
    // Today's (pre-fix) bug this pins against: 288 (meaning "1 of 3 cases")
    // read straight through as 288 PIECES delivered out of 864 -> PARTIAL.
    const out = buildDeliveries([caseLine], { "li-case": 288 });
    expect(out).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "DELIVERED", qty: 864 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 288 })).toBe(300);
  });

  it("a mix of a unit-aware line and a plain line: only the plain one is short-pickable to a partial", () => {
    const plain = { orderItemId: "li-plain", productId: "p-plain", orderedQty: 10, subtotal: 100 };
    const qtyById = { "li-case": 0, "li-plain": 5 };
    expect(buildDeliveries([caseLine, plain], qtyById)).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "REFUSED", qty: 0 },
      { orderItemId: "li-plain", productId: "p-plain", type: "PARTIAL", qty: 5 },
    ]);
    // 0 (case line refused) + 50 (100 * 5/10) = 50.
    expect(reconciledTotal([caseLine, plain], qtyById)).toBe(50);
  });
});
