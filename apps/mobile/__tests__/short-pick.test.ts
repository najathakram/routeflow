import {
  deliveryTypeForQty,
  buildDeliveries,
  reconciledTotal,
  isFullyDelivered,
  isUnitAwareLine,
  normalizeDeliveryPlan,
  planPendingButLinesNotLoaded,
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

// B648/SA-094a: a units_v1 line whose OWN unitsPerBox > 1 ("Case", "Pallet"…)
// gets a WHOLE-CASE stepper — `orderedQty` there is base PIECES (count ×
// the line's unitsPerBox snapshot), and a delivered qty other than a whole
// multiple of the case size has no physical meaning. The driver picks
// n in {0..count}; the plan sends deliveredQty = n x unitsPerBox.
// `effectiveDeliveredQty` snaps any raw entry DOWN to the nearest whole
// multiple, so a stray/leftover value (e.g. 300 on a 288-piece Case) can
// never leak a fractional Case into the money math. A factor-1 unit line
// ("Piece", unitsPerBox 1) is excluded — its pieces ARE individually
// countable, so it keeps the ordinary piece stepper/clamp.
describe("B648/SA-094a: a unit-aware line (unitsPerBox > 1) gets a whole-Case stepper", () => {
  const caseLine = {
    orderItemId: "li-case",
    productId: "p-case",
    orderedQty: 864, // 3 Cases of 288
    subtotal: 300,
    unitLabel: "Case",
    unitsPerBox: 288,
    boxes: 3,
  };

  it("isUnitAwareLine requires BOTH unitLabel and unitsPerBox > 1", () => {
    expect(isUnitAwareLine(caseLine)).toBe(true);
    // SA-094: a factor-1 unit line ("Piece") is NOT unit-aware.
    expect(isUnitAwareLine({ unitLabel: "Piece", unitsPerBox: 1 })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: "Piece", unitsPerBox: null })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: "Piece", unitsPerBox: undefined })).toBe(false);
    // No unitLabel at all -> a plain pack line, regardless of unitsPerBox.
    expect(isUnitAwareLine({ unitLabel: null, unitsPerBox: 288 })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: undefined, unitsPerBox: 288 })).toBe(false);
    expect(isUnitAwareLine({ unitLabel: "", unitsPerBox: 288 })).toBe(false);
  });

  it("untouched (no entry) defaults to n = count (3 of 3), DELIVERED — same default as every other line", () => {
    expect(buildDeliveries([caseLine], {})).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "DELIVERED", qty: 864 },
    ]);
    expect(reconciledTotal([caseLine], {})).toBe(300);
    expect(isFullyDelivered([caseLine], {})).toBe(true);
  });

  it("n = 0 gives REFUSED at qty 0, and the reconciled total excludes the line", () => {
    expect(buildDeliveries([caseLine], { "li-case": 0 })).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "REFUSED", qty: 0 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 0 })).toBe(0);
    expect(isFullyDelivered([caseLine], { "li-case": 0 })).toBe(false);
  });

  it("n = count (864 = 3 x 288) gives DELIVERED at the full amount", () => {
    expect(buildDeliveries([caseLine], { "li-case": 864 })).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "DELIVERED", qty: 864 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 864 })).toBe(300);
  });

  it("n = 2 of 3 Cases (576 pieces) gives PARTIAL at two-thirds of the subtotal", () => {
    expect(buildDeliveries([caseLine], { "li-case": 576 })).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "PARTIAL", qty: 576 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 576 })).toBe(200); // 300 x 576/864
  });

  it("a stray non-multiple entry (300) snaps DOWN to the nearest whole Case (288, n=1) — never a fractional Case", () => {
    // Today's (pre-fix, binary-choice) bug this class replaces pinned 288
    // resolving to the full amount; SA-094a's whole-Case stepper instead
    // snaps a stray entry DOWN to the nearest whole Case it represents.
    const out = buildDeliveries([caseLine], { "li-case": 300 });
    expect(out).toEqual([
      { orderItemId: "li-case", productId: "p-case", type: "PARTIAL", qty: 288 },
    ]);
    expect(reconciledTotal([caseLine], { "li-case": 300 })).toBe(100); // 300 x 288/864 — ONE whole Case
    expect(reconciledTotal([caseLine], { "li-case": 300 })).not.toBe(300); // never the old force-full bug
  });

  it("SA-094: a factor-1 unit line ('Piece', unitsPerBox 1) is not unit-aware — keeps the ordinary piece stepper/clamp", () => {
    const pieceLine = {
      orderItemId: "li-piece",
      productId: "p-piece",
      orderedQty: 10,
      subtotal: 100,
      unitLabel: "Piece",
      unitsPerBox: 1,
      boxes: null,
    };
    expect(isUnitAwareLine(pieceLine)).toBe(false);
    expect(buildDeliveries([pieceLine], { "li-piece": 6 })).toEqual([
      { orderItemId: "li-piece", productId: "p-piece", type: "PARTIAL", qty: 6 },
    ]);
    expect(reconciledTotal([pieceLine], { "li-piece": 6 })).toBe(60);
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

  // SA-094b: ONE exported normalizer must feed BOTH money halves (run-money.ts's
  // deliveredCategoryTax/shortPickCategoryTax have no unit-awareness of their
  // own) AND the review row's displayed qty/badge — reading the raw plan in
  // only one of those places is exactly how a stray 288-of-864 entry used to
  // bill the full subtotal while charging a third of the category tax and
  // showing "Short" next to a "Delivered" total.
  describe("normalizeDeliveryPlan (SA-094b)", () => {
    it("snaps a unit-aware line's stray entry THE SAME WAY buildDeliveries/reconciledTotal do", () => {
      expect(normalizeDeliveryPlan([caseLine], { "li-case": 300 })).toEqual({ "li-case": 288 });
    });

    it("defaults an untouched line to its full ordered qty", () => {
      expect(normalizeDeliveryPlan([caseLine], {})).toEqual({ "li-case": 864 });
    });

    it("clamps a plain line to [0, orderedQty]", () => {
      const plain = {
        orderItemId: "li-plain",
        productId: "p-plain",
        orderedQty: 10,
        subtotal: 100,
      };
      expect(normalizeDeliveryPlan([plain], { "li-plain": 999 })).toEqual({ "li-plain": 10 });
      expect(normalizeDeliveryPlan([plain], { "li-plain": -5 })).toEqual({ "li-plain": 0 });
    });
  });
});

// SA-094a review (5): payment.tsx must refuse to close a stop rather than
// silently discard a driver's already-recorded short-pick plan while the
// order's richer data (shortPickLines) hasn't loaded yet.
describe("planPendingButLinesNotLoaded (SA-094a review 5)", () => {
  it("true: the driver recorded a plan, but shortPickLines is still empty (order[0] not loaded)", () => {
    expect(planPendingButLinesNotLoaded({ "li-1": 0 }, [])).toBe(true);
  });

  it("false: no recorded plan yet (nothing to lose by closing)", () => {
    expect(planPendingButLinesNotLoaded({}, [])).toBe(false);
  });

  it("false: shortPickLines has loaded, so the recorded plan will be honored", () => {
    const plain = { orderItemId: "li-plain", productId: "p-plain", orderedQty: 10, subtotal: 100 };
    expect(planPendingButLinesNotLoaded({ "li-plain": 5 }, [plain])).toBe(false);
  });
});
