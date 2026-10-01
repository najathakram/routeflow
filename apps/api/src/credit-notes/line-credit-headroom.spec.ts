import {
  addCredits,
  allocateProductQty,
  loadLineCredits,
  type HeadroomLine,
} from "./line-credit-headroom";

const A: HeadroomLine = { id: "a", productId: "pa", subtotal: 100, qty: 1 };
const B: HeadroomLine = { id: "b", productId: "pb", subtotal: 100, qty: 1 };

describe("allocateProductQty (SA-628: one shared per-line headroom)", () => {
  it("a whole-line return takes the line's exact remaining amount", () => {
    const r = allocateProductQty([A, B], new Map(), "pa", 1);
    expect(r.items).toEqual([{ invoiceItemId: "a", qty: 1, amount: 100 }]);
    expect(r.shortfallQty).toBe(0);
  });
  it("a prior $33.33 credit on A leaves 66.67: the refund of the whole line is a SHORTFALL on qty? no: it takes the rest, never 100", () => {
    const credited = new Map([["a", { amount: 33.33, qty: 0.3333 }]]);
    const r = allocateProductQty([A, B], credited, "pa", 1);
    // only 0.667 qty / $66.67 remain on A: the rest of the return cannot be credited
    expect(r.items).toEqual([{ invoiceItemId: "a", qty: 0.667, amount: 66.67 }]);
    expect(r.shortfallQty).toBeCloseTo(0.333, 3);
  });
  it("a fully credited line takes nothing and the whole qty is a shortfall (B's slack is never borrowed)", () => {
    const r = allocateProductQty([A, B], new Map([["a", { amount: 100, qty: 1 }]]), "pa", 1);
    expect(r.items).toEqual([]);
    expect(r.shortfallQty).toBe(1);
  });
  it("a product on two lines fills them in order, closing the first exactly", () => {
    const two: HeadroomLine[] = [
      { id: "l1", productId: "p", subtotal: 30, qty: 3 },
      { id: "l2", productId: "p", subtotal: 20, qty: 2 },
    ];
    const r = allocateProductQty(two, new Map(), "p", 4);
    expect(r.items).toEqual([
      { invoiceItemId: "l1", qty: 3, amount: 30 },
      { invoiceItemId: "l2", qty: 1, amount: 10 },
    ]);
  });
  it("a 1/3 split of a $100 line never goes a cent over (the closing take takes the exact rest)", () => {
    const line: HeadroomLine = { id: "x", productId: "p", subtotal: 100, qty: 3 };
    let credited: Map<string, { amount: number; qty: number }> = new Map();
    let total = 0;
    for (let i = 0; i < 3; i++) {
      const r = allocateProductQty([line], credited, "p", 1);
      credited = addCredits(credited, r.items);
      total += r.items[0].amount;
    }
    expect(Math.round(total * 100) / 100).toBe(100);
    expect(allocateProductQty([line], credited, "p", 1).items).toEqual([]);
  });
});

describe("loadLineCredits (item-bearing notes + the legacy itemless-refund term)", () => {
  it("counts CreditNoteItem rows AND an old itemless refund note via its return's qty x the line's linear value", async () => {
    const db = {
      creditNoteItem: {
        findMany: jest.fn().mockResolvedValue([{ invoiceItemId: "a", amount: 33.33, qty: 0.333 }]),
      },
      creditNote: { findMany: jest.fn().mockResolvedValue([{ id: "cn-legacy" }]) },
      return: { findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pb", qty: 1 }] }]) },
    };
    const out = await loadLineCredits(db, "inv", [A, B]);
    expect(out.get("a")).toEqual({ amount: 33.33, qty: 0.333 });
    expect(out.get("b")).toEqual({ amount: 100, qty: 1 }); // the legacy refund of B's whole line
    // the legacy lookup is scoped to the INVOICE and to non-VOID itemless notes
    expect(db.creditNote.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          invoiceId: "inv",
          status: { not: "VOID" },
          items: { none: {} },
        }),
      }),
    );
  });
  it("no itemless notes: no return lookup at all", async () => {
    const db = {
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      creditNote: { findMany: jest.fn().mockResolvedValue([]) },
      return: { findMany: jest.fn() },
    };
    expect((await loadLineCredits(db, "inv", [A])).size).toBe(0);
    expect(db.return.findMany).not.toHaveBeenCalled();
  });
  it("excludeCreditNoteId leaves the reissued note out of BOTH terms", async () => {
    const db = {
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      creditNote: { findMany: jest.fn().mockResolvedValue([]) },
      return: { findMany: jest.fn() },
    };
    await loadLineCredits(db, "inv", [A], { excludeCreditNoteId: "cn-x" });
    expect(db.creditNoteItem.findMany.mock.calls[0][0].where.creditNote).toMatchObject({
      id: { not: "cn-x" },
    });
    expect(db.creditNote.findMany.mock.calls[0][0].where).toMatchObject({ id: { not: "cn-x" } });
  });
});
