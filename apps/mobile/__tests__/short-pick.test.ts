import {
  deliveryTypeForQty,
  buildDeliveries,
  reconciledTotal,
  isFullyDelivered,
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
    expect(shortPickLinesFromOrder(order)).toEqual([
      {
        orderItemId: "li-1",
        productId: "p-1",
        orderedQty: 10,
        subtotal: 100,
        freeUnits: 1,
        freeUnitSize: 5,
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
    expect(shortPickLinesFromOrder(order).map((l) => l.orderItemId)).toEqual(["li-2"]);
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
    expect(shortPickLinesFromOrder(order).map((l) => l.orderItemId)).toEqual(["li-2"]);
  });

  it("null/undefined order or missing lineItems -> empty array, never throws", () => {
    expect(shortPickLinesFromOrder(null)).toEqual([]);
    expect(shortPickLinesFromOrder(undefined)).toEqual([]);
    expect(shortPickLinesFromOrder({})).toEqual([]);
  });

  it("feeds buildStopDeliveries directly for a real multi-order flow — no adapter needed", () => {
    const orderA = {
      lineItems: [{ id: "li-1", productId: "p-1", status: "PENDING", qty: 4, subtotal: 40 }],
    };
    const orderB = {
      lineItems: [{ id: "li-2", productId: "p-2", status: "PENDING", qty: 6, subtotal: 60 }],
    };
    const out = buildStopDeliveries([
      { orderId: "A", lines: shortPickLinesFromOrder(orderA), deliveredQtyById: {} },
      { orderId: "B", lines: shortPickLinesFromOrder(orderB), deliveredQtyById: { "li-2": 0 } },
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
      lineItems: [{ id: "li-1", productId: "p-1", status: "PENDING", qty: 8, subtotal: 80 }],
    };
    const [line] = fallbackShortPickLines(order);
    expect(line).toEqual({
      orderItemId: "li-1",
      productId: "p-1",
      orderedQty: 8,
      subtotal: 80,
      freeUnits: 0,
      freeUnitSize: 1,
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
      lineItems: [{ id: "li-1", productId: "p-1", status: "PENDING", qty: 6, subtotal: 60 }],
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
