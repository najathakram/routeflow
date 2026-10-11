import * as fs from "fs";
import * as path from "path";
import { foldTarget, loadLiveTrioByProduct } from "./fold-target";
import { foldMergeItems } from "./merge-items";
import { buildMergeLineWrites } from "./merge-line-writes";

/**
 * B297 row 340 (SA-734r2 r-note 3, MED-3): a fold ADDs quantity to an existing line only when the new units
 * would be sold at the SAME rate trio; otherwise the added quantity goes on a new live-stamped line and the old
 * line keeps its own units and trio.
 */
const T = (rate: number, over: Record<string, unknown> = {}) => ({
  trackedCategoryId: "cat-1",
  categoryTaxType: "EXCISE_PER_UNIT",
  categoryTaxRate: rate,
  categoryPriceIncludesTax: false,
  ...over,
});
const NONE = { trackedCategoryId: null };

describe("foldTarget", () => {
  it("ADDs an equal trio and SPLITs a different rate, type or price basis", () => {
    expect(foldTarget(T(0.05), T(0.05))).toBe("ADD");
    expect(foldTarget(T(0.05), T(0.08))).toBe("SPLIT");
    expect(foldTarget(T(0.05), T(0.05, { categoryTaxType: "PERCENT_OF_SALE" }))).toBe("SPLIT");
    expect(foldTarget(T(0.05), T(0.05, { categoryPriceIncludesTax: true }))).toBe("SPLIT");
  });
  it("SPLITs a category move and a newly regulated product; ADDs two uncategorised", () => {
    expect(foldTarget(T(0.05), T(0.05, { trackedCategoryId: "cat-2" }))).toBe("SPLIT");
    expect(foldTarget(NONE, T(0.05))).toBe("SPLIT"); // a 0-levy line, the product became regulated
    expect(foldTarget(T(0.05), NONE)).toBe("SPLIT");
    expect(foldTarget(NONE, NONE)).toBe("ADD");
  });
  it("ADDs when either side has no stamped trio yet (it stamps from that same category)", () => {
    const nullTrio = {
      trackedCategoryId: "cat-1",
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
    };
    expect(foldTarget(nullTrio, T(0.08))).toBe("ADD");
    expect(foldTarget(T(0.08), nullTrio)).toBe("ADD");
    expect(foldTarget(nullTrio, { ...T(0.08), trackedCategoryId: "cat-2" })).toBe("SPLIT");
  });
});

describe("foldMergeItems splits the added quantity when the existing line's trio differs", () => {
  const line = (over: Record<string, unknown> = {}) => ({
    id: "li-1",
    productId: "p1",
    qty: 12,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 1,
    priceType: "STANDARD",
    trackedCategoryId: "cat-1",
    categoryTaxType: "EXCISE_PER_UNIT",
    categoryTaxRate: 0.05,
    categoryPriceIncludesTax: false,
    ...over,
  });
  const live = (rate: number) => new Map([["p1", T(rate)]]);
  const qtyOf = (r: ReturnType<typeof foldMergeItems>) =>
    r.items.map((i: any) => [i.sourceLineId ?? "NEW", i.qty]);

  it("12 @ 0.05, rate -> 0.08, +8 scanned: 12 on the old line (carried) + 8 on a NEW live line", () => {
    const r = foldMergeItems([line()], [{ productId: "p1", qty: 8 }], undefined, live(0.08));
    expect(qtyOf(r)).toEqual([
      ["li-1", 12],
      ["NEW", 8],
    ]);
  });

  it("a 0-levy uncategorised line whose product became regulated: +8 opens a new live line", () => {
    const r = foldMergeItems(
      [
        line({
          trackedCategoryId: null,
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
        }),
      ],
      [{ productId: "p1", qty: 8 }],
      undefined,
      live(0.05),
    );
    expect(qtyOf(r)).toEqual([
      ["li-1", 12],
      ["NEW", 8],
    ]);
  });

  it("the same trio adds to the one line (12 + 8 = 20), as today", () => {
    const r = foldMergeItems([line()], [{ productId: "p1", qty: 8 }], undefined, live(0.05));
    expect(qtyOf(r)).toEqual([["li-1", 20]]);
  });

  it("a second incoming item of the same product folds into the NEW live bucket, not the old line", () => {
    const r = foldMergeItems(
      [line()],
      [
        { productId: "p1", qty: 8 },
        { productId: "p1", qty: 2 },
      ],
      undefined,
      live(0.08),
    );
    expect(qtyOf(r)).toEqual([
      ["li-1", 12],
      ["NEW", 10],
    ]);
  });

  it("without a live trio supplied every fold adds (unchanged behaviour)", () => {
    expect(qtyOf(foldMergeItems([line()], [{ productId: "p1", qty: 8 }]))).toEqual([["li-1", 20]]);
  });
});

describe("buildMergeLineWrites never sums lines of different trios", () => {
  const mline = (over: Record<string, unknown> = {}) => ({
    id: "w1",
    productId: "p1",
    qty: 12,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 1,
    subtotal: 12,
    priceType: "STANDARD" as any,
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    promoFreeUnits: null,
    trackedCategoryId: "cat-1",
    categoryTaxType: "EXCISE_PER_UNIT" as any,
    categoryTaxRate: 0.05,
    categoryPriceIncludesTax: false,
    ...over,
  });
  const opts = {
    promos: [],
    canEarnNew: false,
    categoryFor: () => "cat-1",
    liveUnitsPerBoxFor: () => 0,
  };

  it("an equal-trio loser folds into the winner line as before", () => {
    const { writes } = buildMergeLineWrites(
      [mline()],
      [mline({ id: undefined, qty: 8, subtotal: 8 })],
      opts,
    );
    expect(writes.map((w) => [w.kind, (w as any).data.qty])).toEqual([["update", 20]]);
  });

  it("a different-trio loser moves over as its OWN line, trio copied, never summed", () => {
    const { writes } = buildMergeLineWrites(
      [mline()],
      [mline({ id: undefined, qty: 8, subtotal: 8, categoryTaxRate: 0.08 })],
      opts,
    );
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: "create",
      data: { qty: 8, categoryTaxRate: 0.08, categoryTaxType: "EXCISE_PER_UNIT" },
    });
  });
});

describe("loadLiveTrioByProduct", () => {
  it("returns the category's live trio per product, an uncategorised trio for a product with none", async () => {
    const db = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          { id: "p1", trackedCategoryId: "cat-1" },
          { id: "p2", trackedCategoryId: null },
        ]),
      },
      trackedCategory: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "cat-1", taxType: "EXCISE_PER_UNIT", rate: "0.0800", priceIncludesTax: false },
          ]),
      },
    };
    const m = await loadLiveTrioByProduct(db as any, ["p1", "p2"]);
    expect(m.get("p1")).toEqual(T(0.08));
    expect(m.get("p2")).toEqual({ trackedCategoryId: null });
  });
});

describe("MED-A/MED-B (review): clustering and pack refusal under a split", () => {
  const ml = (over: Record<string, unknown> = {}) => ({
    id: undefined as string | undefined,
    productId: "p1",
    qty: 12,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 1,
    subtotal: 12,
    priceType: "STANDARD" as any,
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    promoFreeUnits: null,
    trackedCategoryId: "cat-1",
    categoryTaxType: "EXCISE_PER_UNIT" as any,
    categoryTaxRate: 0.05,
    categoryPriceIncludesTax: false,
    ...over,
  });
  const o = {
    promos: [],
    canEarnNew: false,
    categoryFor: () => "cat-1",
    liveUnitsPerBoxFor: () => 0,
  };
  const NULLS = { categoryTaxType: null, categoryTaxRate: null, categoryPriceIncludesTax: null };

  it("a NULL-trio winner never pulls loser lines of different trios into one sum", () => {
    const { writes } = buildMergeLineWrites(
      [ml({ id: "w", qty: 5, subtotal: 5, ...NULLS })],
      [
        ml({ qty: 12, subtotal: 12, categoryTaxRate: 0.05 }),
        ml({ qty: 8, subtotal: 8, categoryTaxRate: 0.08 }),
      ],
      o,
    );
    const quantities = writes.map((w: any) => w.data.qty).sort((a: number, b: number) => a - b);
    // the 0.05 and 0.08 lines are never summed together (the NULL-trio winner may take one of them)
    expect(quantities).not.toContain(25);
    expect(quantities.reduce((n: number, q: number) => n + q, 0)).toBeGreaterThanOrEqual(20);
  });

  it("a NULL-trio LOSER listed first is not the representative either", () => {
    const { writes } = buildMergeLineWrites(
      [],
      [
        ml({ id: undefined, qty: 3, subtotal: 3, ...NULLS }),
        ml({ qty: 12, subtotal: 12, categoryTaxRate: 0.05 }),
        ml({ qty: 8, subtotal: 8, categoryTaxRate: 0.08 }),
      ],
      o,
    );
    expect(writes.map((w: any) => w.data.qty)).not.toContain(23);
  });

  it("a scan of another known pack opens a new live bucket instead of a pack refusal when the matching-pack line was split off", () => {
    const stale12 = {
      id: "e1",
      productId: "p1",
      qty: 24,
      boxes: 2,
      pieces: 0,
      unitsPerBox: 12,
      unitPrice: 10,
      priceType: "STANDARD",
      trackedCategoryId: "cat-1",
      categoryTaxType: "EXCISE_PER_UNIT",
      categoryTaxRate: 0.05,
      categoryPriceIncludesTax: false,
    };
    const live6 = {
      ...stale12,
      id: "e2",
      qty: 12,
      boxes: 2,
      unitsPerBox: 6,
      categoryTaxRate: 0.08,
    };
    const r = foldMergeItems(
      [stale12, live6],
      [{ productId: "p1", qty: 12, boxes: 1, pieces: 0 }], // a 12-pack scan
      undefined,
      new Map([["p1", T(0.08)]]),
    );
    expect(r.items.map((i: any) => [i.sourceLineId ?? "NEW", i.unitsPerBox, i.qty])).toEqual([
      ["e1", 12, 24],
      ["e2", 6, 12],
      ["NEW", 12, 12],
    ]);
  });
});

describe("caller pin: every quantity-folding site goes through foldTarget", () => {
  it("the buyer controller hands foldMergeItems the product's live trio too (row 343)", () => {
    const src = fs
      .readFileSync(path.resolve(__dirname, "../buyer/buyer.controller.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).toMatch(/foldMergeItems\([\s\S]{0,900}liveTrioByProduct\(/);
  });

  it("the customer branch of updateOrderItems carries a folded line's own category (row 343)", () => {
    const src = fs
      .readFileSync(path.resolve(__dirname, "orders.service.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).toMatch(/carriedCategoryFor\(order\.lineItems, item, item\.productId\)/);
  });

  it("the staff controller hands foldMergeItems the product's live trio", () => {
    const src = fs
      .readFileSync(path.resolve(__dirname, "orders.controller.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).toMatch(/foldMergeItems\([\s\S]{0,400}liveTrioByProduct\(/);
  });

  it.each(["merge-items.ts", "merge-line-writes.ts"])("%s imports and calls foldTarget", (f) => {
    const src = fs
      .readFileSync(path.resolve(__dirname, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
    expect(src).toMatch(/import \{[^}]*\bfoldTarget\b[^}]*\} from "\.\/fold-target"/);
    expect(src).toMatch(/\bfoldTarget\(/);
  });
});
