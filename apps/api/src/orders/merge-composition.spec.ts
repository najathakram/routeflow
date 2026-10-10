import { buildMergeLineWrites, compositionStampOf, type MergeLine } from "./merge-line-writes";

/**
 * #2717 M3 (SA-579 case 13, C9a/C9b): FIXED lines of one product fold only at the SAME recipe
 * version. A different version is a different composition, so it is never folded into the winner's
 * line; it moves across as its own line carrying its stamp. At the same version the winner's line
 * grows and its components are rescaled from its own stored rows (order-composition sync).
 */
const line = (id: string | undefined, o: Partial<Record<string, unknown>> = {}): MergeLine =>
  ({
    id,
    productId: "recipe-p",
    qty: 24,
    boxes: 1,
    pieces: 0,
    unitsPerBox: 24,
    unitPrice: 30,
    subtotal: 30,
    priceType: "STANDARD",
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    promoFreeUnits: null,
    trackedCategoryId: null,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    compositionMode: "FIXED",
    recipeId: "rec-1",
    recipeVersion: 1,
    ...o,
  }) as unknown as MergeLine;

const opts = {
  promos: [],
  canEarnNew: false,
  categoryFor: () => null,
  liveUnitsPerBoxFor: () => 24,
};

describe("buildMergeLineWrites with FIXED lines (C9a/C9b)", () => {
  it("different recipeVersion: not folded; the loser moves as its own line with its stamp", () => {
    const winner = line("w-1", { recipeId: "rec-1", recipeVersion: 1 });
    const loser = line(undefined, { recipeId: "rec-2", recipeVersion: 2 });
    const { writes } = buildMergeLineWrites([winner], [loser], opts);
    expect(writes).toHaveLength(1);
    expect(writes[0].kind).toBe("create");
    expect(compositionStampOf((writes[0] as unknown as { data: never }).data)).toEqual({
      compositionMode: "FIXED",
      recipeId: "rec-2",
      recipeVersion: 2,
    });
  });

  it("same recipeVersion: folded into the winner's line (one update, 2 boxes = 48 pieces)", () => {
    const winner = line("w-1");
    const loser = line(undefined);
    const { writes } = buildMergeLineWrites([winner], [loser], opts);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ kind: "update", lineId: "w-1", data: { qty: 48, boxes: 2 } });
  });

  it("a plain winner line and a FIXED loser line of one product are not folded", () => {
    const winner = line("w-1", { compositionMode: null, recipeId: null, recipeVersion: null });
    const loser = line(undefined);
    const { writes } = buildMergeLineWrites([winner], [loser], opts);
    expect(writes.map((w) => w.kind)).toEqual(["create"]);
  });

  it("plain lines write no stamp keys at all (byte-identical to before)", () => {
    const plain = { compositionMode: null, recipeId: null, recipeVersion: null };
    const { writes } = buildMergeLineWrites([], [line(undefined, plain)], opts);
    expect(compositionStampOf((writes[0] as unknown as { data: never }).data)).toEqual({});
    expect(Object.keys((writes[0] as { data: object }).data)).not.toContain("compositionMode");
  });
});
