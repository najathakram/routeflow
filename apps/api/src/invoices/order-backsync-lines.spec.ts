import { backSyncTargetKey, orderLineShape, orderLineUnchanged } from "./order-backsync-lines";

describe("orderLineShape (SA-203c)", () => {
  const legacySample = { boxes: 0, pieces: 5, unitsPerBox: null, unitLabel: null };

  it("a single changed invoice line is copied VERBATIM: boxes, pieces, pack and unit label, never re-derived", () => {
    const sample = { boxes: 3, pieces: 8, unitsPerBox: 12, unitLabel: "Case" };
    expect(orderLineShape({ unitsPerBox: 24, boxes: 1 }, { qty: 44, sample }, true)).toEqual({
      qty: 44,
      boxes: 3,
      pieces: 8,
      unitsPerBox: 12,
      unitLabel: "Case",
    });
  });

  it("a legacy 0-box + 5-piece line keeps its split verbatim (no pack invented from the product or qty)", () => {
    expect(orderLineShape(null, { qty: 5, sample: legacySample }, true)).toMatchObject({
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: null,
    });
  });

  it("the non-verbatim path keeps the long-standing rule: the order line's own pack re-splits the billed qty", () => {
    expect(
      orderLineShape({ boxes: 1, unitsPerBox: 12 }, { qty: 30, sample: legacySample }, false),
    ).toMatchObject({ qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 });
  });

  it("0 vs null: a legacy 0-box + 5-piece order line with no pack keeps boxes 0 / pieces 5 on a full re-price", () => {
    const shape = orderLineShape(
      { boxes: 0, pieces: 5, unitsPerBox: null },
      { qty: 5, sample: legacySample, n: 1 },
      false,
    );
    expect(shape).toMatchObject({ qty: 5, boxes: 0, pieces: 5, unitsPerBox: null });
    expect(shape.boxes).not.toBeNull();
  });

  it("0 vs null: a line stored WITHOUT a split (boxes null) stays box-unaware", () => {
    expect(
      orderLineShape(
        { boxes: null, pieces: null, unitsPerBox: null },
        { qty: 5, sample: {}, n: 1 },
        false,
      ),
    ).toMatchObject({ boxes: null, pieces: null });
  });

  describe("Opus delta on the 0-vs-null fix: which line, n > 1, pack = 1", () => {
    const stored05 = { boxes: 0, pieces: 5, unitsPerBox: null };

    it("(a) a stored pack of exactly 1 stays 1 (only 0/unknown becomes null): the live product's pack is never consulted", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: 1 },
        { qty: 5, sample: { boxes: 0, pieces: 5, unitsPerBox: 1 }, n: 1 },
        false,
      );
      expect(shape.unitsPerBox).toBe(1);
      expect(shape).toMatchObject({ boxes: 0, pieces: 5 });
    });

    it("(b) WHICH line: a single invoice line with NO split does not blank the order line's stored split", () => {
      const shape = orderLineShape(
        stored05,
        { qty: 5, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
        false,
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 5 });
    });

    it("(b) WHICH line: a single invoice line WITH a split wins over the order line's", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        { qty: 3, sample: { boxes: 0, pieces: 3, unitsPerBox: null }, n: 1 },
        false,
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 3 });
    });

    it("(c) n > 1 with a qty change: 0 boxes means pieces == qty (6 -> 0 boxes + 6 pieces, never 0 + 5)", () => {
      const shape = orderLineShape(
        stored05,
        { qty: 6, sample: { boxes: 0, pieces: 2, unitsPerBox: null }, n: 2 },
        false,
      );
      expect(shape).toMatchObject({ qty: 6, boxes: 0, pieces: 6, unitsPerBox: null });
    });

    it("n > 1 uses the ORDER line's own split, not the last invoice line's", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        { qty: 9, sample: { boxes: 3, pieces: 1, unitsPerBox: null }, n: 2 },
        false,
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 9 });
    });
  });

  describe("n > 1: the old re-split needs a pack SHARED by every contributing line (second Opus pass)", () => {
    it("an attested re-pack (both lines at 12) is written at 12, not back at the order line's old 24", () => {
      const shape = orderLineShape(
        { boxes: 3, pieces: 0, unitsPerBox: 24 },
        { qty: 36, sample: { boxes: 3, pieces: 0, unitsPerBox: 12 }, n: 2, packs: new Set([12]) },
        false,
      );
      expect(shape).toMatchObject({ qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 });
    });

    it("a no-pack legacy line mixed with a pack-12 line: the pack is unknown, so the order line keeps its split and its own (null) pack, not the box split", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        {
          qty: 17,
          sample: { boxes: 1, pieces: 0, unitsPerBox: 12 },
          n: 2,
          packs: new Set([0, 12]),
        },
        false,
      );
      expect(shape).toMatchObject({ qty: 17, boxes: 0, pieces: 17, unitsPerBox: null });
    });

    it("n > 1 with NO shared pack still re-splits at the ORDER line's own known pack: 2 boxes x 24 + 12 more pieces is 2 boxes + 12 pcs (qty 60), never 2 + 0 at pack 24 (a shape that prices as 48)", () => {
      const shape = orderLineShape(
        { boxes: 2, pieces: 0, unitsPerBox: 24 },
        {
          qty: 60,
          sample: { boxes: null, pieces: null, unitsPerBox: null },
          n: 2,
          packs: new Set([0]),
        },
      );
      expect(shape).toMatchObject({ qty: 60, boxes: 2, pieces: 12, unitsPerBox: 24 });
    });

    it("n > 1 with mixed invoice packs (12 and 24) keeps the order line's pack 24 and re-splits at it", () => {
      const shape = orderLineShape(
        { boxes: 1, pieces: 0, unitsPerBox: 24 },
        {
          qty: 30,
          sample: { boxes: 1, pieces: 0, unitsPerBox: 12 },
          n: 2,
          packs: new Set([12, 24]),
        },
      );
      expect(shape).toMatchObject({ qty: 30, boxes: 1, pieces: 6, unitsPerBox: 24 });
    });

    it("a LOOSE order line fed by n > 1 lines at pack 1 keeps its own pack (the levy must not fall back to the live pack)", () => {
      const shape = orderLineShape(
        { boxes: null, pieces: null, unitsPerBox: 12 },
        {
          qty: 7,
          sample: { boxes: null, pieces: null, unitsPerBox: 1 },
          n: 2,
          packs: new Set([1]),
        },
      );
      expect(shape).toMatchObject({ qty: 7, boxes: null, pieces: null, unitsPerBox: 12 });
    });

    it("differing known packs (12 and 24) are not a shared pack: the stored split is kept", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        {
          qty: 12,
          sample: { boxes: 1, pieces: 0, unitsPerBox: 24 },
          n: 2,
          packs: new Set([12, 24]),
        },
        false,
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 12, unitsPerBox: null });
    });
  });

  it("a selling-unit order line stays unsplit", () => {
    expect(
      orderLineShape({ boxes: null, unitsPerBox: null }, { qty: 7, sample: {} }, false),
    ).toMatchObject({ qty: 7, boxes: null, pieces: null, unitsPerBox: null });
  });
});

describe("backSyncTargetKey", () => {
  const byId = new Map([["oi-1", { id: "oi-1" }]]);
  const byProduct = new Map([["p-2", { id: "oi-2" }]]);

  it("prefers the stored order-line link, then the product, then a new product line", () => {
    expect(backSyncTargetKey({ orderItemId: "oi-1", productId: "p-2" }, byId, byProduct)).toBe(
      "line:oi-1",
    );
    expect(backSyncTargetKey({ productId: "p-2" }, byId, byProduct)).toBe("line:oi-2");
    expect(backSyncTargetKey({ productId: "p-9" }, byId, byProduct)).toBe("product:p-9");
    expect(backSyncTargetKey({}, byId, byProduct)).toBeNull();
  });
});

describe("orderLineUnchanged (1b: a discount/shipping-only save must not rewrite identical order lines)", () => {
  const held = {
    qty: "5.000",
    boxes: 0,
    pieces: 5,
    unitsPerBox: null,
    unitPrice: "11.00",
    subtotal: "4.58",
    categoryTaxAmount: "0.00",
    promoFreeUnits: null,
    invoicedQty: "5.000",
    status: "PENDING",
    unitLabel: null,
  };
  const shape = { qty: 5, boxes: 0, pieces: 5, unitsPerBox: null };
  const agg = { unitPrice: 11, subtotal: 4.58, categoryTax: 0, freeUnits: 0 };

  it("identical figures (Decimals as strings) are unchanged: no write", () => {
    expect(orderLineUnchanged(held, shape, agg, false)).toBe(true);
    expect(orderLineUnchanged(held, shape, agg, true)).toBe(true);
  });

  it("a short-delivered line that must shrink to its billed qty IS a change", () => {
    expect(orderLineUnchanged({ ...held, qty: "10.000" }, shape, agg, false)).toBe(false);
  });

  it("a status other than PENDING (the recompute resets it) is a change, as is a moved invoicedQty or 0 vs null boxes", () => {
    expect(orderLineUnchanged({ ...held, status: "DELIVERED" }, shape, agg, false)).toBe(false);
    expect(orderLineUnchanged({ ...held, invoicedQty: "0.000" }, shape, agg, false)).toBe(false);
    expect(orderLineUnchanged({ ...held, boxes: null }, shape, agg, false)).toBe(false);
  });
});
