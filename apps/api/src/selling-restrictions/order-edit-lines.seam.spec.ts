import {
  sellableLinesForMergeEdit,
  sellableLinesForReplaceEdit,
  type EditItem,
  type ExistingLine,
} from "./order-edit-lines";

/**
 * The seam between the two order-edit helpers, pinned for the wiring PR. They mirror two different
 * branches of `OrdersService.updateOrderItems`, and those size a box split differently:
 *   - MERGE prefers the LINE's own `unitsPerBox` snapshot (a repacked product does not re-price or
 *     re-size a line already on the order);
 *   - REPLACE-ALL re-creates every line, so it sizes BOTH the incoming and the carried side with the
 *     product's LIVE box size.
 * Neither is wrong: each is faithful to its branch. What must not happen is a "cleanup" that gives
 * both the same box size, or a caller that supplies live sizes for one branch and not the other.
 */
describe("order-edit helpers — snapshot (merge) vs live (replace) box size", () => {
  // 2 boxes of 12 = 24 pieces, stored with a snapshot of 12. The product has since been repacked
  // to 24 per box (live).
  const stored: ExistingLine = {
    id: "li-1",
    productId: "p1",
    qty: 24,
    boxes: 2,
    pieces: 0,
    unitsPerBox: 12,
    status: "PENDING",
  };
  const live24 = new Map<string, number | null>([["p1", 24]]);

  it("the SAME `2 boxes` echo is a no-op in the merge branch (snapshot 12) but +24 pieces in replace-all (live 24)", () => {
    const merge = sellableLinesForMergeEdit([stored], [{ id: "li-1", boxes: 2 }] as EditItem[], {
      liveUnitsPerBox: live24,
    });
    const replace = sellableLinesForReplaceEdit(
      [stored],
      [{ productId: "p1", boxes: 2 }] as EditItem[],
      { actor: "staff", liveUnitsPerBox: live24 },
    );

    expect(merge).toStrictEqual([{ productId: "p1", qtyDelta: 0 }]); // 2 × 12 vs 24 carried
    expect(replace).toStrictEqual([{ productId: "p1", qtyDelta: 24 }]); // 2 × 24 vs 24 carried
  });

  it("the merge branch never consults the live size while the line has a snapshot; replace-all cannot size without it", () => {
    const echo = [{ id: "li-1", boxes: 2 }] as EditItem[];
    expect(sellableLinesForMergeEdit([stored], echo)).toStrictEqual([
      { productId: "p1", qtyDelta: 0 },
    ]); // no live map at all: the snapshot is enough
    expect(
      sellableLinesForReplaceEdit([stored], [{ productId: "p1", boxes: 2 }] as EditItem[], {
        actor: "staff",
      }),
    ).toStrictEqual([{ productId: "p1" }]); // no live size: UNSIZED, so it is checked
  });
});
