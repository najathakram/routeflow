/**
 * Pure logic for the variant-split sheet (`components/VariantSplitSheet.tsx`):
 * remaining-pool math, live per-row clamping, and the
 * `POST /inventory/variant-assign` payload builder. See
 * `lib/variant-split-logic.ts`.
 */
import {
  applyRowQtyChange,
  buildVariantAssignPayload,
  clampToAvailable,
  parseCostText,
  remainingPool,
  resolvedRowQty,
  type SplitRow,
} from "../lib/variant-split-logic";

describe("parseCostText", () => {
  it("keeps a decimal cost intact", () => {
    expect(parseCostText("2.75")).toBe(2.75);
  });

  it("rounds to the 4dp cost precision", () => {
    expect(parseCostText("1.234567")).toBe(1.2346);
  });

  it("reads a half-typed '2.' as 2 without disturbing the text the row holds", () => {
    // The ROW keeps "2." verbatim so the next keystroke lands on "2.7"; only
    // the payload parse collapses it. Backing the field by this number is what
    // made the decimal point unenterable.
    expect(parseCostText("2.")).toBe(2);
  });

  it("is null for blank text", () => {
    expect(parseCostText("")).toBeNull();
    expect(parseCostText("   ")).toBeNull();
  });

  it("is null for non-numeric or negative text", () => {
    expect(parseCostText("abc")).toBeNull();
    expect(parseCostText("-1")).toBeNull();
    expect(parseCostText(null)).toBeNull();
    expect(parseCostText(undefined)).toBeNull();
  });
});

describe("resolvedRowQty", () => {
  it("uses the raw qty for a non-boxed parent", () => {
    expect(resolvedRowQty({ qty: 7, boxes: null, pieces: null }, null)).toBe(7);
  });

  it("boxes/pieces win over qty for a boxed parent when a split is present", () => {
    // 2 cases of 12 + 3 loose = 27, even though qty was stale at 5.
    expect(resolvedRowQty({ qty: 5, boxes: 2, pieces: 3 }, 12)).toBe(27);
  });

  it("falls back to qty when no boxes/pieces split has been entered yet", () => {
    expect(resolvedRowQty({ qty: 4, boxes: null, pieces: null }, 12)).toBe(4);
  });

  it("never goes negative", () => {
    expect(resolvedRowQty({ qty: -3, boxes: null, pieces: null }, null)).toBe(0);
  });
});

describe("remainingPool", () => {
  const unitsPerBox: number | null = null;

  it("subtracts every row's resolved qty from the pool", () => {
    const rows: SplitRow[] = [
      { key: "a", productId: "a", qty: 3 },
      { key: "b", productId: "b", qty: 5 },
    ];
    expect(remainingPool(20, rows, unitsPerBox)).toBe(12);
  });

  it("floors at 0 rather than going negative", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 999 }];
    expect(remainingPool(10, rows, unitsPerBox)).toBe(0);
  });

  it("is the full pool with no rows", () => {
    expect(remainingPool(20, [], unitsPerBox)).toBe(20);
  });

  it("uses the boxed resolution when the parent is boxed", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 0, boxes: 1, pieces: 6 }];
    expect(remainingPool(30, rows, 12)).toBe(30 - 18);
  });
});

describe("clampToAvailable", () => {
  it("passes a desired qty through when there's enough room", () => {
    expect(clampToAvailable(5, 20, 10)).toBe(5);
  });

  it("clamps to what's left after the other rows", () => {
    expect(clampToAvailable(15, 20, 10)).toBe(10);
  });

  it("floors a negative desired qty at 0", () => {
    expect(clampToAvailable(-4, 20, 0)).toBe(0);
  });

  it("floors available at 0 when other rows already exceed the pool", () => {
    expect(clampToAvailable(5, 10, 999)).toBe(0);
  });
});

describe("applyRowQtyChange — non-boxed parent", () => {
  const rows: SplitRow[] = [
    { key: "a", productId: "a", qty: 4 },
    { key: "b", productId: "b", qty: 6 },
  ];

  it("lets a row grow within the remaining pool", () => {
    // pool 20, other row (b) holds 6 -> row a can take up to 14.
    const next = applyRowQtyChange(rows, "a", { qty: 10 }, 20, null);
    expect(next.find((r) => r.key === "a")?.qty).toBe(10);
  });

  it("clamps a row's qty down to what's left after the other rows", () => {
    // pool 10, other row (b) holds 6 -> row a can take at most 4.
    const next = applyRowQtyChange(rows, "a", { qty: 999 }, 10, null);
    expect(next.find((r) => r.key === "a")?.qty).toBe(4);
  });

  it("leaves every other row untouched", () => {
    const next = applyRowQtyChange(rows, "a", { qty: 1 }, 20, null);
    expect(next.find((r) => r.key === "b")?.qty).toBe(6);
  });
});

describe("applyRowQtyChange — boxed parent", () => {
  const unitsPerBox = 12;

  it("re-splits boxes/pieces from a clamped total", () => {
    // pool 30, no other rows -> row can hold at most 30 units.
    // Desired: 3 cases (36) — over by 6, clamps to 30 -> 2 cases + 6 loose.
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 0, boxes: 0, pieces: 0 }];
    const next = applyRowQtyChange(rows, "a", { boxes: 3 }, 30, unitsPerBox);
    const row = next.find((r) => r.key === "a")!;
    expect(row.boxes).toBe(2);
    expect(row.pieces).toBe(6);
    expect(row.qty).toBe(30);
  });

  it("accounts for other rows' current assignment when clamping", () => {
    // pool 30, row b already holds 12 (1 case) -> row a has 18 available.
    const rows: SplitRow[] = [
      { key: "a", productId: "a", qty: 0, boxes: 0, pieces: 0 },
      { key: "b", productId: "b", qty: 0, boxes: 1, pieces: 0 },
    ];
    const next = applyRowQtyChange(rows, "a", { boxes: 2 }, 30, unitsPerBox);
    const row = next.find((r) => r.key === "a")!;
    // Desired 2 cases = 24, available = 18 -> 1 case + 6 loose.
    expect(row.boxes).toBe(1);
    expect(row.pieces).toBe(6);
    expect(row.qty).toBe(18);
  });

  it("passes a within-range boxes/pieces edit through unchanged", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 0, boxes: 0, pieces: 0 }];
    const next = applyRowQtyChange(rows, "a", { boxes: 1, pieces: 5 }, 30, unitsPerBox);
    const row = next.find((r) => r.key === "a")!;
    expect(row.boxes).toBe(1);
    expect(row.pieces).toBe(5);
    expect(row.qty).toBe(17);
  });
});

describe("buildVariantAssignPayload", () => {
  it("drops zero-qty rows", () => {
    const rows: SplitRow[] = [
      { key: "a", productId: "a", qty: 0 },
      { key: "b", productId: "b", qty: 5 },
    ];
    const payload = buildVariantAssignPayload("parent-1", rows, null);
    expect(payload?.assignments).toEqual([{ productId: "b", qty: 5 }]);
  });

  it("drops an unnamed new-variant row even with a qty entered", () => {
    const rows: SplitRow[] = [{ key: "new-1", newVariantName: "  ", qty: 4 }];
    const payload = buildVariantAssignPayload("parent-1", rows, null);
    expect(payload).toBeNull();
  });

  it("includes a named new-variant row with a trimmed name", () => {
    const rows: SplitRow[] = [{ key: "new-1", newVariantName: "  Cherry  ", qty: 4 }];
    const payload = buildVariantAssignPayload("parent-1", rows, null);
    expect(payload?.assignments).toEqual([{ newVariant: { name: "Cherry" }, qty: 4 }]);
  });

  it("returns null when every row is empty", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 0 }];
    expect(buildVariantAssignPayload("parent-1", rows, null)).toBeNull();
  });

  it("sends boxes/pieces (not qty) for a boxed parent, normalized", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 0, boxes: 2, pieces: 15 }];
    // 2 cases + 15 loose at unitsPerBox 12 normalizes to 3 cases + 3 loose.
    const payload = buildVariantAssignPayload("parent-1", rows, 12);
    expect(payload?.assignments).toEqual([{ productId: "a", boxes: 3, pieces: 3 }]);
  });

  it("parses the raw cost text into a finite non-negative unitCostOverride", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 5, unitCostText: "3.25" }];
    const payload = buildVariantAssignPayload("parent-1", rows, null);
    expect(payload?.assignments).toEqual([{ productId: "a", qty: 5, unitCostOverride: 3.25 }]);
  });

  it("omits unitCostOverride for blank, half-typed, non-numeric or negative text", () => {
    const rows: SplitRow[] = [
      { key: "a", productId: "a", qty: 5, unitCostText: null },
      { key: "b", productId: "b", qty: 5, unitCostText: "   " },
      { key: "c", productId: "c", qty: 5, unitCostText: "-1" },
      { key: "d", productId: "d", qty: 5, unitCostText: "abc" },
    ];
    const payload = buildVariantAssignPayload("parent-1", rows, null);
    for (const a of payload?.assignments ?? []) {
      expect(a.unitCostOverride).toBeUndefined();
    }
    expect(payload?.assignments).toHaveLength(4);
  });

  it("trims notes and omits the field entirely when blank", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 5 }];
    expect(buildVariantAssignPayload("parent-1", rows, null, "  hello  ")?.notes).toBe("hello");
    expect(buildVariantAssignPayload("parent-1", rows, null, "   ")?.notes).toBeUndefined();
    expect(buildVariantAssignPayload("parent-1", rows, null)?.notes).toBeUndefined();
  });

  it("carries the parentProductId through untouched", () => {
    const rows: SplitRow[] = [{ key: "a", productId: "a", qty: 1 }];
    expect(buildVariantAssignPayload("parent-xyz", rows, null)?.parentProductId).toBe("parent-xyz");
  });
});
