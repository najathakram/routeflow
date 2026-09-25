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
