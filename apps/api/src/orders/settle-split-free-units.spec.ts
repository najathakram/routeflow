import { settleSplitFreeUnits } from "./settle-split-free-units";

/**
 * B297 row 355 (SA-734r2 r-note 6): the post-edit settle pass of the stored-price qty edit, the DRIVER edit and
 * the at-stop change. Only products the edit touched are settled, against the PRE-edit state; empty promos is a
 * strict no-op with no query.
 */
const BOGO = {
  id: "bogo",
  type: "BUY_N_GET_M" as const,
  value: 1,
  minQty: 5,
  scope: "ALL" as const,
};
const row = (id: string, qty: number, free: number | null, over: Record<string, unknown> = {}) => ({
  id,
  productId: "p1",
  qty,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  unitPrice: 1,
  promoFreeUnits: free,
  priceType: "STANDARD",
  originalPrice: null,
  overriddenBy: null,
  status: "PENDING",
  ...over,
});
function fakeTx(post: any[]) {
  return {
    orderItem: {
      findMany: jest.fn().mockResolvedValue(post),
      update: jest.fn().mockResolvedValue({}),
    },
    product: {
      findMany: jest.fn().mockResolvedValue([{ id: "p1", category: null, unitsPerBox: null }]),
    },
  };
}
const updates = (tx: ReturnType<typeof fakeTx>) =>
  Object.fromEntries(
    tx.orderItem.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data.promoFreeUnits]),
  );

describe("settleSplitFreeUnits", () => {
  it("re-measures an edited split pair on the combined qty and writes only the lines that moved", async () => {
    // pre: a=6/free 1, b=6/free 1; the edit touched b's note only -> qty unchanged: NOT touched, nothing moves
    const pre = [row("a", 6, 1), row("b", 6, 1)];
    const untouched = fakeTx([row("a", 6, 1), row("b", 6, 1)]);
    await settleSplitFreeUnits(untouched, "ord-1", pre, [BOGO]);
    expect(untouched.orderItem.update).not.toHaveBeenCalled();
    expect(untouched.product.findMany).not.toHaveBeenCalled();
  });

  it("a touched pair is re-allocated oldest first (6 + 7: floor(13/6) = 2)", async () => {
    const pre = [row("a", 6, 1), row("b", 6, 1)];
    const tx = fakeTx([row("a", 6, 1), row("b", 7, 1)]); // the edit raised b from 6 to 7
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    expect(updates(tx)).toEqual({ a: 2, b: null });
  });

  it("empty promos: no query, no write", async () => {
    const tx = fakeTx([row("a", 6, 1), row("b", 6, 1)]);
    await settleSplitFreeUnits(tx, "ord-1", [row("a", 6, 1), row("b", 6, 1)], []);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("a one-line order is never settled", async () => {
    const tx = fakeTx([row("a", 12, 2)]);
    await settleSplitFreeUnits(tx, "ord-1", [row("a", 12, 2)], [BOGO]);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
  });

  it("H-A: the line holding the free units is short-picked; the PRE-edit units are the licence, so the rest still earns", async () => {
    // pre: a=6/free 2 (all of the pair's free units on the oldest line), b=6/free 0.
    // post: a short-picked to 4 and its per-line rescale zeroed it; b untouched.
    const pre = [row("a", 6, 2), row("b", 6, 0)];
    const tx = fakeTx([row("a", 4, null), row("b", 6, null)]);
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    // combined 10 whole units earn floor(10/6) = 1, the oldest line takes it
    expect(updates(tx)).toEqual({ a: 1 });
  });

  it("H-A: the sibling is CANCELLED and one line is left; the remaining line still earns what 6 units earn", async () => {
    const pre = [row("a", 6, 2), row("b", 6, 0)];
    const tx = fakeTx([row("b", 6, null)]); // a is no longer a live line
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    expect(updates(tx)).toEqual({ b: 1 });
  });

  it("H-B: a unit-aware line in the product's lines excludes it (never promoted, never counted as packs)", async () => {
    const pre = [row("a", 4, 1), row("piece", 5, null, { unitLabel: "Piece", unitsPerBox: 1 })];
    const tx = fakeTx([
      row("a", 4, 1),
      row("piece", 6, null, { unitLabel: "Piece", unitsPerBox: 1 }),
    ]);
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    expect(tx.orderItem.update).not.toHaveBeenCalled();
  });

  it("M-C: a product the edit did not touch is never re-priced by someone else's edit", async () => {
    const other = (id: string, qty: number, free: number | null) =>
      row(id, qty, free, { productId: "p2" });
    const pre = [row("a", 4, 2), row("b", 4, 0), other("c", 4, 2), other("d", 4, 0)];
    // only p1's line b changed
    const tx = fakeTx([row("a", 4, 2), row("b", 5, 0), other("c", 4, 2), other("d", 4, 0)]);
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    for (const call of tx.orderItem.update.mock.calls)
      expect(["a", "b"]).toContain(call[0].where.id);
    expect(tx.product.findMany.mock.calls[0][0].where.id.in).toEqual(["p1"]);
  });

  it("MED-1: free units a line CREATED by this edit was priced with are part of the licence (an at-door ADD_ITEM)", async () => {
    // pre: L1 holds 4 units (0 free), L9 another product. The edit creates L2 (6 units) priced with 1 free.
    const pre = [row("l1", 4, 0), row("x", 3, 0, { productId: "p2" })];
    const tx = fakeTx([
      row("l1", 4, null),
      row("l2", 6, 1),
      row("x", 3, null, { productId: "p2" }),
    ]);
    await settleSplitFreeUnits(tx, "ord-1", pre, [BOGO]);
    // combined 10 earn 1 under the live rule: the unit is NOT stripped (it moves to the oldest line)
    expect(updates(tx)).toEqual({ l1: 1, l2: null });
  });
});
