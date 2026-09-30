/**
 * Locks the stock-count sheet math: per-scan row accumulation, REPLACE vs ADD
 * variance, and the commit payload (never empty; server skips zero-delta lines).
 */
import {
  addScanToRows,
  buildCommitItems,
  buildCommitSummary,
  buildRowCommitSummary,
  changedRowCount,
  groupRowsByVariance,
  groupSessionLinesByVariance,
  hydrateRowsFromSession,
  newSessionId,
  rowEditPatch,
  rowVariance,
  rowVarianceMoney,
  sessionLineVariance,
  sessionLineVarianceMoney,
  totalRowVarianceMoney,
  totalVarianceMoney,
  type StockCountRow,
  type StockCountSessionLine,
} from "../lib/stock-count-logic";

const P = { id: "p1", name: "Cola 24pk", sku: "COLA24", unit: "case", currentStock: 10 };

describe("addScanToRows", () => {
  it("adds a new row seeded from current stock", () => {
    const rows = addScanToRows([], P, 1, "REPLACE");
    expect(rows).toEqual([
      {
        productId: "p1",
        name: "Cola 24pk",
        sku: "COLA24",
        unit: "case",
        stockBefore: 10,
        counted: 1,
        mode: "REPLACE",
      },
    ]);
  });
  it("increments an existing row's counted by qtyPerScan, keeps stockBefore/mode", () => {
    const once = addScanToRows([], P, 2, "ADD");
    const twice = addScanToRows(once, P, 2, "ADD");
    expect(twice).toHaveLength(1);
    expect(twice[0].counted).toBe(4);
    expect(twice[0].stockBefore).toBe(10);
    expect(twice[0].mode).toBe("ADD");
  });
  it("coerces a string/undefined currentStock to a number", () => {
    expect(
      addScanToRows([], { id: "x", name: "X", currentStock: "7" }, 1, "REPLACE")[0].stockBefore,
    ).toBe(7);
    expect(addScanToRows([], { id: "y", name: "Y" }, 1, "REPLACE")[0].stockBefore).toBe(0);
  });
});

describe("rowVariance", () => {
  it("REPLACE: delta = counted − before", () => {
    expect(rowVariance({ mode: "REPLACE", counted: 8, stockBefore: 10 })).toEqual({
      delta: -2,
      after: 8,
    });
  });
  it("ADD: delta = counted, after = before + counted", () => {
    expect(rowVariance({ mode: "ADD", counted: 3, stockBefore: 10 })).toEqual({
      delta: 3,
      after: 13,
    });
  });
});

describe("buildCommitItems", () => {
  it("maps every row (including zero-delta — server skips those, DTO needs ≥1)", () => {
    const rows: StockCountRow[] = [
      { productId: "p1", name: "A", stockBefore: 10, counted: 10, mode: "REPLACE" }, // zero delta
      { productId: "p2", name: "B", stockBefore: 0, counted: 5, mode: "ADD" },
    ];
    expect(buildCommitItems(rows)).toEqual([
      { productId: "p1", quantity: 10, mode: "REPLACE" },
      { productId: "p2", quantity: 5, mode: "ADD" },
    ]);
  });
  it("clamps a negative counted to 0 (DTO @Min(0))", () => {
    expect(
      buildCommitItems([{ productId: "p", name: "P", stockBefore: 0, counted: -3, mode: "ADD" }])[0]
        .quantity,
    ).toBe(0);
  });
});

describe("changedRowCount", () => {
  it("counts only rows with a non-zero delta", () => {
    const rows: StockCountRow[] = [
      { productId: "a", name: "A", stockBefore: 10, counted: 10, mode: "REPLACE" }, // 0
      { productId: "b", name: "B", stockBefore: 10, counted: 12, mode: "REPLACE" }, // +2
      { productId: "c", name: "C", stockBefore: 0, counted: 0, mode: "ADD" }, // 0
    ];
    expect(changedRowCount(rows)).toBe(1);
  });
});

describe("newSessionId", () => {
  it("returns an RFC-4122 v4 UUID (server @IsUUID)", () => {
    expect(newSessionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});

// ─── Durable stock-count sessions (PR-C) ────────────────────────────────────

function line(overrides: Partial<StockCountSessionLine> = {}): StockCountSessionLine {
  return {
    id: "line-1",
    productId: "p1",
    mode: "REPLACE",
    countedQty: 10,
    expectedQty: 10,
    countedById: "user-1",
    updatedAt: "2026-08-19T00:00:00.000Z",
    product: { id: "p1", name: "Cola 24pk", sku: "COLA24", unit: "case", averageCost: 3 },
    ...overrides,
  };
}

describe("sessionLineVariance", () => {
  it("REPLACE: delta = counted − expected (reuses rowVariance's mode math)", () => {
    expect(sessionLineVariance({ mode: "REPLACE", countedQty: 8, expectedQty: 10 })).toEqual({
      delta: -2,
      after: 8,
    });
  });
  it("ADD: delta = counted, after = expected + counted", () => {
    expect(sessionLineVariance({ mode: "ADD", countedQty: 3, expectedQty: 10 })).toEqual({
      delta: 3,
      after: 13,
    });
  });
  it("coerces string Decimal fields (Prisma serializes Decimal as a string over JSON)", () => {
    expect(sessionLineVariance({ mode: "REPLACE", countedQty: "8.5", expectedQty: "10" })).toEqual({
      delta: -1.5,
      after: 8.5,
    });
  });
});

describe("sessionLineVarianceMoney", () => {
  it("qty variance × the product's CURRENT averageCost, rounded to cents", () => {
    const l = line({
      countedQty: 13,
      expectedQty: 10,
      product: { id: "p1", name: "X", averageCost: 2.995 },
    });
    // delta = 3, 3 * 2.995 = 8.985 -> rounds to 8.99 (roundMoney, half-up on the cent)
    expect(sessionLineVarianceMoney(l)).toBeCloseTo(8.99, 2);
  });
  it("ignores unitCostOverride entirely — variance $ always uses averageCost", () => {
    const l = line({
      countedQty: 12,
      expectedQty: 10,
      unitCostOverride: 999,
      product: { id: "p1", name: "X", averageCost: 1 },
    });
    expect(sessionLineVarianceMoney(l)).toBe(2); // 2 * 1, NOT 2 * 999
  });
  it("a negative variance yields a negative $ figure", () => {
    const l = line({
      countedQty: 5,
      expectedQty: 10,
      product: { id: "p1", name: "X", averageCost: 4 },
    });
    expect(sessionLineVarianceMoney(l)).toBe(-20);
  });
  it("treats a missing averageCost as 0 rather than NaN", () => {
    const l = line({ countedQty: 12, expectedQty: 10, product: { id: "p1", name: "X" } });
    expect(sessionLineVarianceMoney(l)).toBe(0);
  });
});

describe("groupSessionLinesByVariance", () => {
  it("splits zero-variance lines (matched) from everything else (changed)", () => {
    const matchedLine = line({ productId: "a", countedQty: 10, expectedQty: 10 });
    const changedLine = line({ productId: "b", countedQty: 12, expectedQty: 10 });
    const { matched, changed } = groupSessionLinesByVariance([matchedLine, changedLine]);
    expect(matched.map((l) => l.productId)).toEqual(["a"]);
    expect(changed.map((l) => l.productId)).toEqual(["b"]);
  });
  it("an ADD-mode line with counted=0 is zero variance (nothing added)", () => {
    const l = line({ mode: "ADD", countedQty: 0, expectedQty: 10 });
    const { matched, changed } = groupSessionLinesByVariance([l]);
    expect(matched).toHaveLength(1);
    expect(changed).toHaveLength(0);
  });
});

describe("totalVarianceMoney / buildCommitSummary", () => {
  it("sums variance $ across only the changed lines", () => {
    const lines = [
      line({
        productId: "a",
        countedQty: 10,
        expectedQty: 10,
        product: { id: "a", name: "A", averageCost: 5 },
      }), // matched, $0
      line({
        productId: "b",
        countedQty: 12,
        expectedQty: 10,
        product: { id: "b", name: "B", averageCost: 2 },
      }), // +2 * 2 = +4
      line({
        productId: "c",
        countedQty: 7,
        expectedQty: 10,
        product: { id: "c", name: "C", averageCost: 3 },
      }), // -3 * 3 = -9
    ];
    expect(totalVarianceMoney(groupSessionLinesByVariance(lines).changed)).toBe(-5);

    const summary = buildCommitSummary(lines);
    expect(summary).toEqual({ changedCount: 2, matchedCount: 1, netVarianceMoney: -5 });
  });

  it("an all-matched session reports a zero net variance and zero changed lines", () => {
    const lines = [line({ countedQty: 10, expectedQty: 10 })];
    expect(buildCommitSummary(lines)).toEqual({
      changedCount: 0,
      matchedCount: 1,
      netVarianceMoney: 0,
    });
  });
});

describe("hydrateRowsFromSession", () => {
  it("maps a server line to a StockCountRow, using expectedQty as stockBefore", () => {
    const l = line({
      productId: "p1",
      countedQty: "12",
      expectedQty: "10",
      boxes: 1,
      pieces: 2,
      unitCostOverride: "4.5000",
      product: {
        id: "p1",
        name: "Cola 24pk",
        sku: "COLA24",
        unit: "case",
        unitsPerBox: 24,
        averageCost: "3.1000",
      },
    });
    expect(hydrateRowsFromSession([l])).toEqual([
      {
        productId: "p1",
        name: "Cola 24pk",
        sku: "COLA24",
        unit: "case",
        stockBefore: 10,
        counted: 12,
        mode: "REPLACE",
        boxes: 1,
        pieces: 2,
        unitsPerBox: 24,
        unitCostOverride: 4.5,
        averageCost: 3.1,
      },
    ]);
  });

  it("leaves boxes/pieces/unitCostOverride/averageCost undefined when absent", () => {
    const l = line({ product: { id: "p1", name: "X" } });
    const [row] = hydrateRowsFromSession([l]);
    expect(row.boxes).toBeUndefined();
    expect(row.pieces).toBeUndefined();
    expect(row.unitsPerBox).toBeUndefined();
    expect(row.unitCostOverride).toBeUndefined();
    expect(row.averageCost).toBeUndefined();
  });
});

describe("rowEditPatch", () => {
  it("sends a flat countedQty for a non-boxed row", () => {
    const row: StockCountRow = {
      productId: "p1",
      name: "X",
      stockBefore: 0,
      counted: 7,
      mode: "REPLACE",
    };
    expect(rowEditPatch(row)).toEqual({ countedQty: 7 });
  });
  it("sends boxes/pieces (never a flat countedQty) once the row has a stored split", () => {
    const row: StockCountRow = {
      productId: "p1",
      name: "X",
      stockBefore: 0,
      counted: 26,
      mode: "REPLACE",
      boxes: 1,
      pieces: 2,
    };
    expect(rowEditPatch(row)).toEqual({ boxes: 1, pieces: 2 });
  });
  it("never omits countedQty — the server treats an absent one as 0", () => {
    // A mode-only or unit-cost-only change must still round-trip the count.
    const row: StockCountRow = {
      productId: "p1",
      name: "X",
      stockBefore: 0,
      counted: 5,
      mode: "ADD",
    };
    const patch = rowEditPatch(row);
    expect(patch.countedQty).toBe(5);
  });
  it("clamps a negative counted/boxes/pieces to 0", () => {
    const row: StockCountRow = {
      productId: "p",
      name: "P",
      stockBefore: 0,
      counted: -3,
      mode: "ADD",
    };
    expect(rowEditPatch(row)).toEqual({ countedQty: 0 });
  });
  it("carries unitCostOverride only when the row has one set", () => {
    const withOverride: StockCountRow = {
      productId: "p1",
      name: "X",
      stockBefore: 0,
      counted: 5,
      mode: "REPLACE",
      unitCostOverride: 3.25,
    };
    expect(rowEditPatch(withOverride).unitCostOverride).toBe(3.25);
    const without: StockCountRow = {
      productId: "p1",
      name: "X",
      stockBefore: 0,
      counted: 5,
      mode: "REPLACE",
    };
    expect(rowEditPatch(without)).not.toHaveProperty("unitCostOverride");
  });
});

describe("groupRowsByVariance / totalRowVarianceMoney / buildRowCommitSummary", () => {
  const rows: StockCountRow[] = [
    { productId: "a", name: "A", stockBefore: 10, counted: 10, mode: "REPLACE", averageCost: 5 }, // matched
    { productId: "b", name: "B", stockBefore: 10, counted: 12, mode: "REPLACE", averageCost: 2 }, // +2 * 2 = +4
    { productId: "c", name: "C", stockBefore: 10, counted: 7, mode: "REPLACE", averageCost: 3 }, // -3 * 3 = -9
  ];

  it("splits matched vs changed the same way the session-line version does", () => {
    const { matched, changed } = groupRowsByVariance(rows);
    expect(matched.map((r) => r.productId)).toEqual(["a"]);
    expect(changed.map((r) => r.productId)).toEqual(["b", "c"]);
  });

  it("rowVarianceMoney treats a missing averageCost as 0", () => {
    expect(rowVarianceMoney({ mode: "REPLACE", counted: 12, stockBefore: 10 })).toBe(0);
  });

  it("sums net variance $ across the changed rows only", () => {
    expect(totalRowVarianceMoney(groupRowsByVariance(rows).changed)).toBe(-5);
  });

  it("buildRowCommitSummary matches buildCommitSummary's shape for the equivalent data", () => {
    expect(buildRowCommitSummary(rows)).toEqual({
      changedCount: 2,
      matchedCount: 1,
      netVarianceMoney: -5,
    });
  });
});
