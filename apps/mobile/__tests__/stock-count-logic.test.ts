/**
 * Locks the stock-count sheet math: per-scan row accumulation, REPLACE vs ADD
 * variance, and the commit payload (never empty; server skips zero-delta lines).
 */
import {
  addScanToRows,
  buildCommitItems,
  changedRowCount,
  newSessionId,
  rowVariance,
  type StockCountRow,
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
