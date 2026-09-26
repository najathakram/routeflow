import {
  deliveryTypeForQty,
  buildDeliveries,
  reconciledTotal,
  isFullyDelivered,
  isUnitAwareLine,
  normalizeDeliveryPlan,
  planPendingButLinesNotLoaded,
  buildStopDeliveries,
  shortPickLinesFromOrder,
  fallbackShortPickLines,
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
// B762: the signature became per-order — (deliveredQtyById, orderItemIds,
// landed) — so a multi-order stop can ask the question for each order's
// own fetch state instead of a single shared shortPickLines array.
describe("planPendingButLinesNotLoaded (SA-094a review 5 / B762 per-order signature)", () => {
  it("true: the driver recorded a plan, but this order's fetch hasn't landed", () => {
    expect(planPendingButLinesNotLoaded({ "li-1": 0 }, ["li-1"], false)).toBe(true);
  });

  it("false: no recorded plan yet (nothing to lose by closing)", () => {
    expect(planPendingButLinesNotLoaded({}, ["li-1"], false)).toBe(false);
  });

  it("false: the order has landed, so the recorded plan will be honored", () => {
    expect(planPendingButLinesNotLoaded({ "li-plain": 5 }, ["li-plain"], true)).toBe(false);
  });
});

describe("shortPickLinesFromOrder (B762: the shared derivation both driver screens now use)", () => {
  it("maps an order's lines to ShortPickLine, carrying freeUnits/freeUnitSize", () => {
    const order = {
      lineItems: [
        {
          id: "li-1",
          productId: "p-1",
          status: "PENDING",
          deliveredQty: 0,
          qty: 10,
          subtotal: 100,
          promoFreeUnits: 1,
          boxes: 1,
          unitsPerBox: 5,
        },
      ],
    };
    // SA-367a: a first visit is served remaining == qty.
    expect(shortPickLinesFromOrder(order, { "li-1": 10 })).toEqual([
      {
        orderItemId: "li-1",
        productId: "p-1",
        orderedQty: 10,
        subtotal: 100,
        freeUnits: 1,
        freeUnitSize: 5,
        unitLabel: null,
        unitsPerBox: 5,
        boxes: 1,
        pieces: 5, // FIX 6 (SA-175): qty(10) − boxes(1)×unitsPerBox(5)
      },
    ]);
  });

  it("excludes CANCELLED lines", () => {
    const order = {
      lineItems: [
        { id: "li-1", productId: "p-1", status: "CANCELLED", qty: 10, subtotal: 100 },
        { id: "li-2", productId: "p-2", status: "PENDING", qty: 5, subtotal: 50 },
      ],
    };
    // The server serves a cancelled line remaining 0 (SA-366).
    expect(
      shortPickLinesFromOrder(order, { "li-1": 0, "li-2": 5 }).map((l) => l.orderItemId),
    ).toEqual(["li-2"]);
    // And the status filter holds even where no remaining was served.
    expect(shortPickLinesFromOrder(order, {}).map((l) => l.orderItemId)).toEqual(["li-2"]);
  });

  it("excludes a line already delivered (a reopened, partially-completed stop doesn't re-offer a settled line)", () => {
    const order = {
      lineItems: [
        {
          id: "li-1",
          productId: "p-1",
          status: "PENDING",
          deliveredQty: 10,
          qty: 10,
          subtotal: 100,
        },
        { id: "li-2", productId: "p-2", status: "PENDING", deliveredQty: 0, qty: 5, subtotal: 50 },
      ],
    };
    // Served: the settled line has remaining 0.
    expect(
      shortPickLinesFromOrder(order, { "li-1": 0, "li-2": 5 }).map((l) => l.orderItemId),
    ).toEqual(["li-2"]);
    // Older api (no remaining): the pre-B785 rule, and the surviving line awaits entry.
    const legacy = shortPickLinesFromOrder(order, {});
    expect(legacy.map((l) => l.orderItemId)).toEqual(["li-2"]);
    expect(legacy[0]!.needsEntry).toBe(true);
  });

  it("null/undefined order or missing lineItems -> empty array, never throws", () => {
    expect(shortPickLinesFromOrder(null, {})).toEqual([]);
    expect(shortPickLinesFromOrder(undefined, {})).toEqual([]);
    expect(shortPickLinesFromOrder({}, {})).toEqual([]);
  });

  it("feeds buildStopDeliveries directly for a real multi-order flow — no adapter needed", () => {
    const orderA = {
      lineItems: [{ id: "li-1", productId: "p-1", status: "PENDING", qty: 4, subtotal: 40 }],
    };
    const orderB = {
      lineItems: [{ id: "li-2", productId: "p-2", status: "PENDING", qty: 6, subtotal: 60 }],
    };
    const out = buildStopDeliveries([
      { orderId: "A", lines: shortPickLinesFromOrder(orderA, { "li-1": 4 }), deliveredQtyById: {} },
      {
        orderId: "B",
        lines: shortPickLinesFromOrder(orderB, { "li-2": 6 }),
        deliveredQtyById: { "li-2": 0 },
      },
    ]);
    expect(out).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", quantityDelivered: 4 },
      { orderItemId: "li-2", productId: "p-2", type: "REFUSED", quantityDelivered: 0 },
    ]);
  });
});

describe("fallbackShortPickLines (SA-115: the un-landed-order fallback)", () => {
  it("SA-115 required (1): filters CANCELLED lines — a snapshot with one CANCELLED line produces no entry for it", () => {
    const order = {
      lineItems: [
        { id: "li-1", productId: "p-1", status: "CANCELLED", qty: 10, subtotal: 100 },
        { id: "li-2", productId: "p-2", status: "PENDING", qty: 5, subtotal: 50 },
      ],
    };
    expect(fallbackShortPickLines(order).map((l) => l.orderItemId)).toEqual(["li-2"]);
  });

  it("a surviving (non-CANCELLED) line resolves to DELIVERED at full qty through deliveryTypeForQty — no BOGO netting", () => {
    const order = {
      lineItems: [
        { id: "li-1", productId: "p-1", status: "PENDING", qty: 8, subtotal: 80, remaining: 8 },
      ],
    };
    const [line] = fallbackShortPickLines(order);
    expect(line).toEqual({
      orderItemId: "li-1",
      productId: "p-1",
      orderedQty: 8,
      subtotal: 80,
      freeUnits: 0,
      freeUnitSize: 1,
      unitLabel: null,
      unitsPerBox: null,
      boxes: null,
      pieces: null,
    });
    expect(deliveryTypeForQty(line!.orderedQty, line!.orderedQty)).toBe("DELIVERED");
  });

  it("null/undefined order or missing lineItems -> empty array, never throws", () => {
    expect(fallbackShortPickLines(null)).toEqual([]);
    expect(fallbackShortPickLines(undefined)).toEqual([]);
    expect(fallbackShortPickLines({})).toEqual([]);
  });

  it("SA-115 required (2), the composition an un-landed vs. a landed order must produce: an un-landed order's fallback lines contribute their full-qty snapshot to buildStopDeliveries; a LANDED order with nothing adjustable (empty rich lines) contributes NO entries at all — never a re-claimed full delivery", () => {
    const unlandedSnapshot = {
      lineItems: [
        { id: "li-1", productId: "p-1", status: "PENDING", qty: 6, subtotal: 60, remaining: 6 },
      ],
    };
    // A landed order whose shortPickLinesFromOrder came back empty (e.g.
    // every line already delivered on an earlier visit) — the caller must
    // pass its RICH (empty) lines here, never fallbackShortPickLines(o).
    const out = buildStopDeliveries([
      {
        orderId: "unlanded",
        lines: fallbackShortPickLines(unlandedSnapshot),
        deliveredQtyById: {},
      },
      { orderId: "landed-nothing-adjustable", lines: [], deliveredQtyById: {} },
    ]);
    expect(out).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", quantityDelivered: 6 },
    ]);
  });
});

describe("buildStopDeliveries (B762/SA-109/SA-109a: multi-order stop coverage)", () => {
  const orderALines = lines; // li-1 (qty 10), li-2 (qty 2)
  const orderBLines = [
    { orderItemId: "li-3", productId: "p-3", orderedQty: 5, subtotal: 50 },
    { orderItemId: "li-4", productId: "p-4", orderedQty: 4, subtotal: 40 },
  ];

  it("Case 1 — all delivered: every line of every order gets an explicit DELIVERED entry at full qty, even an order the driver never touched (empty deliveredQtyById)", () => {
    const out = buildStopDeliveries([
      { orderId: "A", lines: orderALines, deliveredQtyById: {} },
      { orderId: "B", lines: orderBLines, deliveredQtyById: {} },
    ]);
    expect(out).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: "li-2", productId: "p-2", type: "DELIVERED", quantityDelivered: 2 },
      { orderItemId: "li-3", productId: "p-3", type: "DELIVERED", quantityDelivered: 5 },
      { orderItemId: "li-4", productId: "p-4", type: "DELIVERED", quantityDelivered: 4 },
    ]);
  });

  it("Case 2 — one order entirely refused: EVERY line of the refused order carries an explicit REFUSED/0 entry — never simply absent from the payload", () => {
    const out = buildStopDeliveries([
      { orderId: "A", lines: orderALines, deliveredQtyById: {} },
      { orderId: "B", lines: orderBLines, deliveredQtyById: { "li-3": 0, "li-4": 0 } },
    ]);
    // Order A: untouched, full DELIVERED (Case 1's guarantee holds alongside a refused sibling).
    expect(out.filter((d) => d.orderItemId === "li-1" || d.orderItemId === "li-2")).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: "li-2", productId: "p-2", type: "DELIVERED", quantityDelivered: 2 },
    ]);
    // Order B: both lines explicitly REFUSED at qty 0 — not omitted, not defaulted to delivered.
    expect(out.filter((d) => d.orderItemId === "li-3" || d.orderItemId === "li-4")).toEqual([
      { orderItemId: "li-3", productId: "p-3", type: "REFUSED", quantityDelivered: 0 },
      { orderItemId: "li-4", productId: "p-4", type: "REFUSED", quantityDelivered: 0 },
    ]);
    expect(out).toHaveLength(4);
  });

  it("Case 3 — partial/mixed: order A full, order B has one short line — B's OTHER line still gets its own explicit full-qty entry, never omitted just because a sibling line is short", () => {
    const out = buildStopDeliveries([
      { orderId: "A", lines: orderALines, deliveredQtyById: {} },
      { orderId: "B", lines: orderBLines, deliveredQtyById: { "li-3": 2 } }, // li-4 untouched -> full
    ]);
    expect(out).toEqual([
      { orderItemId: "li-1", productId: "p-1", type: "DELIVERED", quantityDelivered: 10 },
      { orderItemId: "li-2", productId: "p-2", type: "DELIVERED", quantityDelivered: 2 },
      { orderItemId: "li-3", productId: "p-3", type: "PARTIAL", quantityDelivered: 2 },
      { orderItemId: "li-4", productId: "p-4", type: "DELIVERED", quantityDelivered: 4 },
    ]);
  });

  it("type always matches quantityDelivered exactly (SA-109a: server 400s a mismatch) — REFUSED only at 0, DELIVERED only at the full ordered qty", () => {
    const out = buildStopDeliveries([
      { orderId: "A", lines: orderALines, deliveredQtyById: { "li-1": 0, "li-2": 1 } },
    ]);
    for (const entry of out) {
      const src = [...orderALines].find((l) => l.orderItemId === entry.orderItemId)!;
      expect(entry.type).toBe(deliveryTypeForQty(entry.quantityDelivered, src.orderedQty));
    }
  });

  it("an order omitted from the input array entirely contributes NOTHING — callers must pass every order the driver handled, never rely on this function to fill gaps", () => {
    const out = buildStopDeliveries([{ orderId: "A", lines: orderALines, deliveredQtyById: {} }]);
    expect(out.some((d) => d.orderItemId === "li-3" || d.orderItemId === "li-4")).toBe(false);
    expect(out).toHaveLength(2);
  });
});
