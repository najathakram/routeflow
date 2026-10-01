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
  it("REFUND mode never clips: a prior $33.33 credit leaves $66.67 of a $100 line, so returning the whole line is a refusal", () => {
    const credited = new Map([["a", { amount: 33.33, qty: 0.333 }]]);
    const r = allocateProductQty([A, B], credited, "pa", 1);
    expect(r.items).toEqual([]);
    expect(r.refusal).toMatchObject({
      productId: "pa",
      requestedAmount: 100,
      remainingAmount: 66.67,
    });
  });
  it("COUNT mode (the legacy history term) MAY clip to what the line has left", () => {
    const credited = new Map([["a", { amount: 33.33, qty: 0.333 }]]);
    const r = allocateProductQty([A, B], credited, "pa", 1, "count");
    expect(r.items).toEqual([{ invoiceItemId: "a", qty: 0.667, amount: 66.67 }]);
    expect(r.refusal).toBeUndefined();
  });
  it("REFUND mode: qty is left but the money is short ($100/10pc line, $50 credited with explicit qty 1, 9 pcs back = $90 > $50) is a refusal", () => {
    const line: HeadroomLine = { id: "x", productId: "p", subtotal: 100, qty: 10 };
    const r = allocateProductQty([line], new Map([["x", { amount: 50, qty: 1 }]]), "p", 9);
    expect(r.items).toEqual([]);
    expect(r.refusal).toMatchObject({
      productId: "p",
      requestedAmount: 90,
      remainingAmount: 50,
      requestedQty: 9,
      remainingQty: 9,
    });
  });
  it("REFUND mode: an exact rest within 1 cent is allowed (it takes the line's remaining amount)", () => {
    const line: HeadroomLine = { id: "x", productId: "p", subtotal: 100, qty: 3 };
    const r = allocateProductQty([line], new Map([["x", { amount: 66.67, qty: 2 }]]), "p", 1);
    expect(r.refusal).toBeUndefined();
    expect(r.items).toEqual([{ invoiceItemId: "x", qty: 1, amount: 33.33 }]);
  });
  it("a $0 line takes its qty at amount 0: money binds only when the line has money (a free unit is NOT refused)", () => {
    const free: HeadroomLine = { id: "f", productId: "p", subtotal: 0, qty: 2 };
    const r = allocateProductQty([free], new Map(), "p", 2);
    expect(r.items).toEqual([{ invoiceItemId: "f", qty: 2, amount: 0 }]);
    expect(r.shortfallQty).toBe(0);
    expect(r.refusal).toBeUndefined();
  });
  it("$100/10pc + a $0/2pc line of one product: a full 12-pc return is $100 + $0, not a refusal", () => {
    const lines: HeadroomLine[] = [
      { id: "paid", productId: "p", subtotal: 100, qty: 10 },
      { id: "free", productId: "p", subtotal: 0, qty: 2 },
    ];
    const r = allocateProductQty(lines, new Map(), "p", 12);
    expect(r.items).toEqual([
      { invoiceItemId: "paid", qty: 10, amount: 100 },
      { invoiceItemId: "free", qty: 2, amount: 0 },
    ]);
    expect(r.shortfallQty).toBe(0);
  });
  it("a fully credited line takes nothing and the whole qty is a shortfall (B's slack is never borrowed)", () => {
    const r = allocateProductQty([A, B], new Map([["a", { amount: 100, qty: 1 }]]), "pa", 1);
    expect(r.items).toEqual([]);
    expect(r.shortfallQty).toBe(1); // qty is gone: a shortfall (the caller refuses 409)
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
  it("the legacy term keys on the CN LINK, not the return status: a PROCESSED return counts and no status filter is sent", async () => {
    const db = {
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      creditNote: { findMany: jest.fn().mockResolvedValue([{ id: "cn-old" }]) },
      return: { findMany: jest.fn().mockResolvedValue([{ items: [{ productId: "pa", qty: 1 }] }]) },
    };
    const out = await loadLineCredits(db, "inv", [A, B]);
    expect(out.get("a")).toEqual({ amount: 100, qty: 1 });
    const where = db.return.findMany.mock.calls[0][0].where;
    expect(where).toEqual({ creditNoteId: { in: ["cn-old"] } });
    expect(where).not.toHaveProperty("status");
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
  it("rounding drift: six 1/6 refunds of a $1.00 line all pass (the closing take absorbs the drift)", () => {
    const line: HeadroomLine = { id: "d", productId: "p", subtotal: 1, qty: 6 };
    let credited = new Map<string, { amount: number; qty: number }>();
    for (let k = 0; k < 6; k++) {
      const r = allocateProductQty([line], credited, "p", 1);
      expect(r.refusal).toBeUndefined();
      credited = addCredits(credited, r.items);
    }
    expect(credited.get("d")?.qty).toBe(6);
  });
  it("COUNT mode skips a free line: legacy qty lands on the paid line, not on a $0 line ahead of it", () => {
    const free: HeadroomLine = { id: "f", productId: "p", subtotal: 0, qty: 1 };
    const paid: HeadroomLine = { id: "q", productId: "p", subtotal: 100, qty: 10 };
    const r = allocateProductQty([free, paid], new Map(), "p", 1, "count");
    expect(r.items).toEqual([{ invoiceItemId: "q", qty: 1, amount: 10 }]);
  });
});
