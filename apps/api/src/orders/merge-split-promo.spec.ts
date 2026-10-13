import { PriceType } from "@prisma/client";
import { allocateSplitFreeUnits } from "./merge-split-promo";
import type { MergeLine, MergeLineWrite } from "./merge-line-writes";

/**
 * B297 row 355: a buyer-driven merge that leaves one product on several lines earns BUY_N_GET_M on the
 * COMBINED whole-unit count and allocates it oldest line first; nothing else changes.
 */
const BOGO = {
  id: "bogo",
  type: "BUY_N_GET_M" as const,
  value: 1,
  minQty: 5,
  scope: "ALL" as const,
};
const opts = { promos: [BOGO], canEarnNew: true, categoryFor: () => null };

const winner = (id: string, qty: number, over: Record<string, unknown> = {}) =>
  ({
    id,
    productId: "p1",
    qty,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 1,
    subtotal: qty,
    priceType: PriceType.STANDARD,
    originalPrice: null,
    overriddenBy: null,
    promoFreeUnits: null,
    ...over,
  }) as unknown as MergeLine;
const created = (qty: number, over: Record<string, unknown> = {}): MergeLineWrite => ({
  kind: "create",
  data: {
    productId: "p1",
    qty,
    boxes: null,
    pieces: null,
    unitsPerBox: null,
    unitPrice: 1,
    subtotal: qty,
    promoFreeUnits: null,
    priceType: PriceType.STANDARD,
    originalPrice: null,
    overrideReason: null,
    overriddenBy: null,
    notes: null,
    trackedCategoryId: null,
    categoryTaxType: null,
    categoryTaxRate: null,
    categoryPriceIncludesTax: null,
    ...over,
  } as never,
});

describe("allocateSplitFreeUnits", () => {
  it("an untouched winner line (7) and a moved line (5) earn 2 on the combined 12, the oldest line first", () => {
    const out = allocateSplitFreeUnits([created(5)], [winner("a", 7)], opts);
    const create = out.find((w) => w.kind === "create") as Extract<
      MergeLineWrite,
      { kind: "create" }
    >;
    const update = out.find((w) => w.kind === "update") as Extract<
      MergeLineWrite,
      { kind: "update" }
    >;
    expect(update).toMatchObject({ lineId: "a", data: { promoFreeUnits: 2, subtotal: 5 } });
    expect(create.data.promoFreeUnits).toBeNull();
    expect(create.data.subtotal).toBe(5);
  });

  it("a product that ends on ONE line is left to the per-group fold", () => {
    const writes = [
      {
        kind: "update",
        lineId: "a",
        data: { qty: 12, boxes: null, pieces: null, unitsPerBox: null, subtotal: 12 },
      } as MergeLineWrite,
    ];
    expect(allocateSplitFreeUnits(writes, [winner("a", 7)], opts)).toBe(writes);
  });

  it("is off unless the merge is buyer-initiated and a promo is live", () => {
    const writes = [created(5)];
    expect(allocateSplitFreeUnits(writes, [winner("a", 7)], { ...opts, canEarnNew: false })).toBe(
      writes,
    );
    expect(allocateSplitFreeUnits(writes, [winner("a", 7)], { ...opts, promos: [] })).toBe(writes);
  });

  it("never earns on an operator-priced line or a line carrying a price promotion", () => {
    const writes = [created(5)];
    expect(
      allocateSplitFreeUnits(writes, [winner("a", 7, { priceType: PriceType.MANUAL })], opts),
    ).toBe(writes);
    expect(
      allocateSplitFreeUnits(
        writes,
        [winner("a", 7, { priceType: PriceType.PROMO, originalPrice: 2 })],
        opts,
      ),
    ).toBe(writes);
  });

  it("leaves two different packs of one product to the per-pack fold", () => {
    const writes = [created(5, { boxes: 0, pieces: 5, unitsPerBox: 6 })];
    expect(
      allocateSplitFreeUnits(
        writes,
        [winner("a", 12, { boxes: 1, pieces: 0, unitsPerBox: 12 })],
        opts,
      ),
    ).toBe(writes);
  });

  it("a legacy box-split line with a NULL pack snapshot is counted and billed in real boxes (the live pack)", () => {
    // winner: 24 pieces (2 boxes) with no snapshot; created: 5 boxes at pack 12. combined 7 boxes, N=5 M=1 => 1.
    const winnerLegacy = winner("a", 24, { boxes: 2, pieces: 0, unitsPerBox: null });
    const moved = created(60, { boxes: 5, pieces: 0, unitsPerBox: 12 });
    const out = allocateSplitFreeUnits([moved], [winnerLegacy], {
      ...opts,
      liveUnitsPerBoxFor: () => 12,
    });
    const update = out.find((w) => w.kind === "update") as Extract<
      MergeLineWrite,
      { kind: "update" }
    >;
    expect(update).toMatchObject({ lineId: "a", data: { promoFreeUnits: 1 } });
    // 2 boxes at $1.00 per BOX, 1 free: $1.00. Billed as 24 boxes it would be $23.00.
    expect(update.data.subtotal).toBe(1);
  });

  it("M-C: a winner-only product the merge did not write is never re-settled", () => {
    // p1 gets a moved line; p2 is split on the winner and untouched by this merge
    const w = [
      winner("a", 7),
      winner("p2a", 6, { productId: "p2", promoFreeUnits: 1 }),
      winner("p2b", 6, { productId: "p2", promoFreeUnits: 1 }),
    ];
    const out = allocateSplitFreeUnits([created(5)], w, opts);
    const ids = out.filter((x) => x.kind === "update").map((x) => (x as { lineId: string }).lineId);
    expect(ids).toEqual(["a"]);
  });

  it("H-B: a unit-aware winner line keeps its product out of the allocation", () => {
    const out = allocateSplitFreeUnits(
      [created(5)],
      [winner("a", 7, { unitLabel: "Piece", unitsPerBox: 1 })],
      opts,
    );
    expect(out.filter((x) => x.kind === "update")).toEqual([]);
  });

  it("oldest first means createdAt, then position, then id: an older line wins over a smaller id", () => {
    const older = winner("z-old", 6, { createdAt: new Date("2026-01-01"), position: 0 });
    const newer = winner("a-new", 6, { createdAt: new Date("2026-02-01"), position: 0 });
    const out = allocateSplitFreeUnits(
      [
        {
          kind: "update",
          lineId: "a-new",
          data: { qty: 6, boxes: null, pieces: null, unitsPerBox: null, subtotal: 6 },
        } as MergeLineWrite,
      ],
      [newer, older],
      { ...opts, canEarnNew: true },
    );
    const byId = Object.fromEntries(
      out.filter((x) => x.kind === "update").map((x: any) => [x.lineId, x.data.promoFreeUnits]),
    );
    expect(byId["z-old"]).toBe(2); // 12 combined = 2 free, the older line takes both
  });
});
