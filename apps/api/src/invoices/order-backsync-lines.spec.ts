import { backSyncTargetKey, orderLineShape } from "./order-backsync-lines";

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
