import { splitMatchesQty } from "@routeflow/pricing";
import { orderLineShape, orderLineUnchanged } from "./order-backsync-lines";

describe("orderLineShape (SA-203c)", () => {
  const legacySample = { boxes: 0, pieces: 5, unitsPerBox: null, unitLabel: null };

  it("a single changed invoice line is copied VERBATIM: boxes, pieces, pack and unit label, never re-derived", () => {
    const sample = { boxes: 3, pieces: 8, unitsPerBox: 12, unitLabel: "Case" };
    expect(orderLineShape({ unitsPerBox: 24, boxes: 1 }, { qty: 44, sample, n: 1 })).toEqual({
      qty: 44,
      boxes: 3,
      pieces: 8,
      unitsPerBox: 12,
      unitLabel: "Case",
    });
  });

  it("a legacy 0-box + 5-piece line keeps its split verbatim (no pack invented from the product or qty)", () => {
    expect(orderLineShape(null, { qty: 5, sample: legacySample, n: 1 })).toMatchObject({
      qty: 5,
      boxes: 0,
      pieces: 5,
      unitsPerBox: null,
    });
  });

  it("the non-verbatim path keeps the long-standing rule: the order line's own pack re-splits the billed qty", () => {
    expect(
      orderLineShape({ boxes: 1, unitsPerBox: 12 }, { qty: 30, sample: legacySample }),
    ).toMatchObject({ qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 });
  });

  it("0 vs null: a legacy 0-box + 5-piece order line with no pack keeps boxes 0 / pieces 5 on a full re-price", () => {
    const shape = orderLineShape(
      { boxes: 0, pieces: 5, unitsPerBox: null },
      { qty: 5, sample: legacySample, n: 1 },
    );
    expect(shape).toMatchObject({ qty: 5, boxes: 0, pieces: 5, unitsPerBox: null });
    expect(shape.boxes).not.toBeNull();
  });

  it("0 vs null: a line stored WITHOUT a split (boxes null) stays box-unaware", () => {
    expect(
      orderLineShape(
        { boxes: null, pieces: null, unitsPerBox: null },
        { qty: 5, sample: {}, n: 1 },
      ),
    ).toMatchObject({ boxes: null, pieces: null });
  });

  describe("Opus delta on the 0-vs-null fix: which line, n > 1, pack = 1", () => {
    const stored05 = { boxes: 0, pieces: 5, unitsPerBox: null };

    it("(a) a stored pack of exactly 1 stays 1 (only 0/unknown becomes null): the live product's pack is never consulted", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: 1 },
        { qty: 5, sample: { boxes: 0, pieces: 5, unitsPerBox: 1 }, n: 1 },
      );
      expect(shape.unitsPerBox).toBe(1);
      expect(shape).toMatchObject({ boxes: 0, pieces: 5 });
    });

    it("(b) WHICH line: a single invoice line with NO split does not blank the order line's stored split", () => {
      const shape = orderLineShape(stored05, {
        qty: 5,
        sample: { boxes: null, pieces: null, unitsPerBox: null },
        n: 1,
      });
      expect(shape).toMatchObject({ boxes: 0, pieces: 5 });
    });

    it("(b) WHICH line: a single invoice line WITH a split wins over the order line's", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        { qty: 3, sample: { boxes: 0, pieces: 3, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 3 });
    });

    it("(c) n > 1 with a qty change: 0 boxes means pieces == qty (6 -> 0 boxes + 6 pieces, never 0 + 5)", () => {
      const shape = orderLineShape(stored05, {
        qty: 6,
        sample: { boxes: 0, pieces: 2, unitsPerBox: null },
        n: 2,
      });
      expect(shape).toMatchObject({ qty: 6, boxes: 0, pieces: 6, unitsPerBox: null });
    });

    it("n > 1 uses the ORDER line's own split, not the last invoice line's", () => {
      const shape = orderLineShape(
        { boxes: 0, pieces: 5, unitsPerBox: null },
        { qty: 9, sample: { boxes: 3, pieces: 1, unitsPerBox: null }, n: 2 },
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 9 });
    });
  });

  describe("n > 1: the old re-split needs a pack SHARED by every contributing line (second Opus pass)", () => {
    it("an attested re-pack (both lines at 12) is written at 12, not back at the order line's old 24", () => {
      const shape = orderLineShape(
        { boxes: 3, pieces: 0, unitsPerBox: 24 },
        { qty: 36, sample: { boxes: 3, pieces: 0, unitsPerBox: 12 }, n: 2, packs: new Set([12]) },
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

    it("a LOOSE order line fed by n > 1 lines all at pack 1 (no shared pack > 1) keeps its own pack (the levy must not fall back to the live pack)", () => {
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
      );
      expect(shape).toMatchObject({ boxes: 0, pieces: 12, unitsPerBox: null });
    });
  });

  describe("SA-225: one billed line is copied verbatim in EVERY recompute mode", () => {
    it("a non-normalized single-line split (1 box + 14 pcs at pack 12) is kept as billed, never re-derived as 2 + 2", () => {
      const held = { boxes: 1, pieces: 14, unitsPerBox: 12 };
      expect(orderLineShape(held, { qty: 26, sample: held, n: 1 })).toMatchObject({
        qty: 26,
        boxes: 1,
        pieces: 14,
        unitsPerBox: 12,
      });
    });

    it("the single line's pack and label win over the order line's (a re-pack / relabel is carried)", () => {
      const shape = orderLineShape(
        { boxes: 1, pieces: 0, unitsPerBox: 24, unitLabel: null },
        {
          qty: 12,
          sample: { boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" },
          n: 1,
        },
      );
      expect(shape).toMatchObject({ unitsPerBox: 12, unitLabel: "Case" });
    });

    it("the unit label follows the verbatim rule: written from a single billed line that HAS one, otherwise the order line's is kept", () => {
      const withLabel = orderLineShape(
        { boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: null },
        { qty: 12, sample: { boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }, n: 1 },
      );
      expect(withLabel.unitLabel).toBe("Case");
      const without = orderLineShape(
        { boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" },
        { qty: 12, sample: { boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: null }, n: 1 },
      );
      expect(without.unitLabel).toBeUndefined(); // not written: the order line keeps "Case"
    });

    it("legacy billed line with NO pack (2+0) over an order line at pack 12 (2+0): the order line's pack stays 12", () => {
      const shape = orderLineShape(
        { boxes: 2, pieces: 0, unitsPerBox: 12, qty: 24 },
        { qty: 24, sample: { boxes: 2, pieces: 0, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
    });

    it("n === 1 WITHOUT a split keeps a NON-normalized order split as stored: 1 box + 14 pcs at pack 12 stays 1 + 14 (never 2 + 2)", () => {
      const shape = orderLineShape(
        { boxes: 1, pieces: 14, unitsPerBox: 12, qty: 26 },
        { qty: 26, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ qty: 26, boxes: 1, pieces: 14, unitsPerBox: 12 });
    });

    it("...but a MOVED qty over that split re-splits at the order line's own pack (26 -> 30 is 2 boxes + 6 pcs)", () => {
      const shape = orderLineShape(
        { boxes: 1, pieces: 14, unitsPerBox: 12, qty: 26 },
        { qty: 30, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ qty: 30, boxes: 2, pieces: 6, unitsPerBox: 12 });
    });

    describe("invariant: any split the back-sync writes satisfies boxes x pack + pieces === qty (SA-257)", () => {
      const consistent = (s: any) => (s.boxes ?? 0) * (s.unitsPerBox ?? 0) + (s.pieces ?? 0);

      it("corner 1: a legacy order line 1 box + 14 pcs (qty 26) with NO saved pack, billed by one no-split line at pack 24, is re-split at 24 (1 + 2), never written 1 + 14 at pack 24 (38 pcs)", () => {
        const shape = orderLineShape(
          { boxes: 1, pieces: 14, unitsPerBox: null, qty: 26 },
          { qty: 26, sample: { boxes: null, pieces: null, unitsPerBox: 24 }, n: 1 },
        );
        expect(shape).toMatchObject({ qty: 26, boxes: 1, pieces: 2, unitsPerBox: 24 });
        expect(consistent(shape)).toBe(26);
      });

      it("corner 2: a legacy billed line 1 + 0 with NO pack (qty 24) over an order line at pack 12 is written 2 + 0 at pack 12, never 1 + 0 at pack 12 (12 pcs)", () => {
        const shape = orderLineShape(
          { boxes: 2, pieces: 0, unitsPerBox: 12, qty: 24 },
          { qty: 24, sample: { boxes: 1, pieces: 0, unitsPerBox: null }, n: 1 },
        );
        expect(shape).toMatchObject({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
        expect(consistent(shape)).toBe(24);
      });

      it("a CONSISTENT non-normalized split is still kept (1 box + 14 pcs at its own pack 12 = 26)", () => {
        const shape = orderLineShape(
          { boxes: 1, pieces: 14, unitsPerBox: 12, qty: 26 },
          { qty: 26, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
        );
        expect(shape).toMatchObject({ boxes: 1, pieces: 14, unitsPerBox: 12 });
      });

      it("no known pack anywhere: 0 boxes => pieces = qty; a box split is kept as stored (nothing to re-split against)", () => {
        expect(
          orderLineShape(
            { boxes: 0, pieces: 5, unitsPerBox: null, qty: 5 },
            { qty: 7, sample: { boxes: null }, n: 1 },
          ),
        ).toMatchObject({ boxes: 0, pieces: 7, unitsPerBox: null });
        expect(
          orderLineShape(
            { boxes: 2, pieces: 3, unitsPerBox: null, qty: 27 },
            { qty: 27, sample: { boxes: null }, n: 1 },
          ),
        ).toMatchObject({ boxes: 2, pieces: 3, unitsPerBox: null });
      });
    });

    it("a no-split invoice line billing a no-split order line leaves it box-unaware and keeps the order line's own pack (matches master; documented in the header)", () => {
      const shape = orderLineShape(
        { boxes: null, pieces: null, unitsPerBox: 12, qty: 5 },
        { qty: 5, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ qty: 5, boxes: null, pieces: null, unitsPerBox: 12 });
    });

    it("n === 1 WITHOUT a split keeps the ORDER line's own split and pack (SA-227), never blanking it", () => {
      const shape = orderLineShape(
        { boxes: 2, pieces: 0, unitsPerBox: 12 },
        { qty: 24, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      );
      expect(shape).toMatchObject({ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12 });
      expect(shape.unitLabel).toBeUndefined();
    });

    it("n > 1 is NOT verbatim: it keeps the shared-pack rule (no unitLabel written)", () => {
      const shape = orderLineShape(
        { boxes: 3, pieces: 0, unitsPerBox: 24 },
        { qty: 36, sample: { boxes: 1, pieces: 14, unitsPerBox: 12 }, n: 2, packs: new Set([12]) },
      );
      expect(shape).toMatchObject({ boxes: 3, pieces: 0, unitsPerBox: 12 });
      expect(shape.unitLabel).toBeUndefined();
    });
  });

  it("a selling-unit order line stays unsplit", () => {
    expect(
      orderLineShape({ boxes: null, unitsPerBox: null }, { qty: 7, sample: {} }),
    ).toMatchObject({ qty: 7, boxes: null, pieces: null, unitsPerBox: null });
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
    expect(orderLineUnchanged(held, shape, agg)).toBe(true);
  });

  it("a label-only difference IS a change (the unit label is compared and written)", () => {
    expect(orderLineUnchanged(held, { ...shape, unitLabel: "Case" }, agg)).toBe(false);
    expect(
      orderLineUnchanged({ ...held, unitLabel: "Case" }, { ...shape, unitLabel: "Case" }, agg),
    ).toBe(true);
  });

  it("SA-248: a CANCELLED order line that an invoice bills is REVIVED to PENDING (existing behaviour, explicit): CANCELLED is a change, so it is written", () => {
    expect(orderLineUnchanged({ ...held, status: "CANCELLED" }, shape, agg)).toBe(false);
    // and a PENDING line is what an identical re-save leaves alone
    expect(orderLineUnchanged({ ...held, status: "PENDING" }, shape, agg)).toBe(true);
  });

  it("a short-delivered line that must shrink to its billed qty IS a change", () => {
    expect(orderLineUnchanged({ ...held, qty: "10.000" }, shape, agg)).toBe(false);
  });

  it("a status other than PENDING (the recompute resets it) is a change, as is a moved invoicedQty or 0 vs null boxes", () => {
    expect(orderLineUnchanged({ ...held, status: "DELIVERED" }, shape, agg)).toBe(false);
    expect(orderLineUnchanged({ ...held, invoicedQty: "0.000" }, shape, agg)).toBe(false);
    expect(orderLineUnchanged({ ...held, boxes: null }, shape, agg)).toBe(false);
  });
});

describe("orderLineShape: three shape kinds x (consistent, inconsistent, no pack) (SA-257)", () => {
  type Case = {
    name: string;
    existing: any;
    agg: any;
    want: { boxes: number | null; pieces: number | null; unitsPerBox: number | null };
  };
  const cases: Case[] = [
    // VERBATIM: n === 1 with a split
    {
      name: "verbatim / consistent: 2+2 at 12 (26) copied as billed",
      existing: { boxes: 1, pieces: 0, unitsPerBox: 12, qty: 12 },
      agg: { qty: 26, sample: { boxes: 2, pieces: 2, unitsPerBox: 12 }, n: 1 },
      want: { boxes: 2, pieces: 2, unitsPerBox: 12 },
    },
    {
      name: "verbatim / inconsistent: billed 1+14 at 24 for qty 26 is re-split at 24 (1+2)",
      existing: { boxes: 1, pieces: 14, unitsPerBox: null, qty: 26 },
      agg: { qty: 26, sample: { boxes: 1, pieces: 14, unitsPerBox: 24 }, n: 1 },
      want: { boxes: 1, pieces: 2, unitsPerBox: 24 },
    },
    {
      name: "verbatim / inconsistent via the pack fallback: billed legacy 1+0 (no pack, qty 24) over order pack 12 is re-split 2+0 at 12",
      existing: { boxes: 2, pieces: 0, unitsPerBox: 12, qty: 24 },
      agg: { qty: 24, sample: { boxes: 1, pieces: 0, unitsPerBox: null }, n: 1 },
      want: { boxes: 2, pieces: 0, unitsPerBox: 12 },
    },
    {
      name: "verbatim / no pack anywhere: 0 boxes + 5 pcs is copied as billed, no pack invented",
      existing: { boxes: 0, pieces: 5, unitsPerBox: null, qty: 5 },
      agg: { qty: 5, sample: { boxes: 0, pieces: 5, unitsPerBox: null }, n: 1 },
      want: { boxes: 0, pieces: 5, unitsPerBox: null },
    },
    // KEPT: n === 1 without a split over a split order line
    {
      name: "kept / consistent: 1+14 at the order line's OWN pack 12 (26) stays 1+14",
      existing: { boxes: 1, pieces: 14, unitsPerBox: 12, qty: 26 },
      agg: { qty: 26, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      want: { boxes: 1, pieces: 14, unitsPerBox: 12 },
    },
    {
      name: "kept / inconsistent: the order line has NO own pack, the billed line says 24: 1+14 is re-split 1+2 at 24, not kept",
      existing: { boxes: 1, pieces: 14, unitsPerBox: null, qty: 26 },
      agg: { qty: 26, sample: { boxes: null, pieces: null, unitsPerBox: 24 }, n: 1 },
      want: { boxes: 1, pieces: 2, unitsPerBox: 24 },
    },
    {
      name: "kept / no pack anywhere: a box split at an unknown pack stays as stored (SA-211), 0 boxes => pieces = qty",
      existing: { boxes: 2, pieces: 3, unitsPerBox: null, qty: 27 },
      agg: { qty: 27, sample: { boxes: null, pieces: null, unitsPerBox: null }, n: 1 },
      want: { boxes: 2, pieces: 3, unitsPerBox: null },
    },
    // RE-SPLIT: n > 1
    {
      name: "re-split / consistent: two lines sharing pack 12, qty 36 -> 3+0 at 12",
      existing: { boxes: 3, pieces: 0, unitsPerBox: 24, qty: 72 },
      agg: {
        qty: 36,
        sample: { boxes: 1, pieces: 6, unitsPerBox: 12 },
        n: 2,
        packs: new Set([12]),
      },
      want: { boxes: 3, pieces: 0, unitsPerBox: 12 },
    },
    {
      name: "re-split / inconsistent stored shape: order 2+0 at 24 with qty 60 becomes 2+12 at 24",
      existing: { boxes: 2, pieces: 0, unitsPerBox: 24, qty: 48 },
      agg: { qty: 60, sample: { boxes: null }, n: 2, packs: new Set([0]) },
      want: { boxes: 2, pieces: 12, unitsPerBox: 24 },
    },
    {
      name: "re-split / no pack anywhere: 0 boxes => pieces = qty",
      existing: { boxes: 0, pieces: 5, unitsPerBox: null, qty: 5 },
      agg: { qty: 9, sample: { boxes: null }, n: 2, packs: new Set([0]) },
      want: { boxes: 0, pieces: 9, unitsPerBox: null },
    },
  ];

  it.each(cases)("$name", ({ existing, agg, want }) => {
    const shape = orderLineShape(existing, agg);
    expect({ boxes: shape.boxes, pieces: shape.pieces, unitsPerBox: shape.unitsPerBox }).toEqual(
      want,
    );
    // the invariant: any split carrying a pack > 1 adds up to its qty
    if ((shape.unitsPerBox ?? 0) > 1 && shape.boxes != null) {
      expect(splitMatchesQty({ ...shape, qty: agg.qty })).toBe(true);
    }
  });
});
