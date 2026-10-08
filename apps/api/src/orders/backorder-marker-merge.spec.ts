import { buildMergeLineWrites, type MergeLine } from "./merge-line-writes";

/**
 * SA-716 MUST 2: the merge fold CARRIES the backorder marker (it is a fact of the sale, never
 * recomputed): the winner line takes the folded losers' markers on top of its own; a loser-only
 * product is created with the loser's marker. Zero markers write no key at all (byte-identical).
 */
const line = (id: string | undefined, marker: number | undefined, o: object = {}): MergeLine =>
  ({
    id,
    productId: "p1",
    qty: 10,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 2,
    subtotal: 20,
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
    ...(marker === undefined ? {} : { backorderedPieces: marker }),
    ...o,
  }) as unknown as MergeLine;

const opts = {
  promos: [],
  canEarnNew: false,
  categoryFor: () => null,
  liveUnitsPerBoxFor: () => 1,
};
const data = (w: unknown) => (w as { data: Record<string, unknown> }).data;

describe("buildMergeLineWrites carries backorderedPieces", () => {
  it("two orders backordering 3 each, merged -> the winner line reads 6", () => {
    const { writes } = buildMergeLineWrites([line("w1", 3)], [line("l1", 3)], opts);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({
      kind: "update",
      lineId: "w1",
      data: { backorderedPieces: 6 },
    });
  });

  it("a winner with no marker takes the loser's; two losers add up", () => {
    const { writes } = buildMergeLineWrites(
      [line("w1", 0)],
      [line("l1", 2), line("l2", 1.5)],
      opts,
    );
    expect(data(writes[0]).backorderedPieces).toBe(3.5);
  });

  it("a loser-only product is created carrying the loser's marker (single move)", () => {
    const { writes } = buildMergeLineWrites([], [line("l1", 4)], opts);
    expect(writes[0].kind).toBe("create");
    expect(data(writes[0]).backorderedPieces).toBe(4);
  });

  it("losers with no marker write NO key (the winner keeps its own, byte-identical to before)", () => {
    const folded = buildMergeLineWrites([line("w1", 5)], [line("l1", 0)], opts).writes;
    expect(Object.keys(data(folded[0]))).not.toContain("backorderedPieces");
    const moved = buildMergeLineWrites([], [line("l1", undefined)], opts).writes;
    expect(Object.keys(data(moved[0]))).not.toContain("backorderedPieces");
  });

  it("a different-pack loser moves as its own line and keeps its OWN marker", () => {
    const winner = line("w1", 3, { qty: 2, boxes: 2, pieces: 0, unitsPerBox: 12 });
    const loser = line("l1", 7, { qty: 1, boxes: 1, pieces: 0, unitsPerBox: 24 });
    const { writes } = buildMergeLineWrites([winner], [loser], opts);
    const created = writes.filter((w) => w.kind === "create");
    expect(created).toHaveLength(1);
    expect(data(created[0]).backorderedPieces).toBe(7);
  });
});
