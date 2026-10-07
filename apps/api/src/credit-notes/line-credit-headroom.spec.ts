import {
  addCredits,
  planProductRefund,
  lineTakeRefusal,
  piecesPerQtyOf,
  loadLineCredits,
  loadOrderPool,
  type HeadroomLine,
} from "./line-credit-headroom";

const A: HeadroomLine = { id: "a", productId: "pa", subtotal: 100, qty: 1 };
const B: HeadroomLine = { id: "b", productId: "pb", subtotal: 100, qty: 1 };

const L = (id: string, subtotal: number, qty: number, productId = "p"): HeadroomLine => ({
  id,
  productId,
  subtotal,
  qty,
});
const credit = (m: Record<string, [number, number, number?]>) =>
  new Map(Object.entries(m).map(([k, [amount, qty, items]]) => [k, { amount, qty, items }]));

describe("planProductRefund (SA-628b: ONE price + itemisation for mint, preview and the legacy term)", () => {
  it("a whole-line return takes the line's exact amount", () => {
    const r = planProductRefund([A, B], new Map(), "pa", 1);
    expect(r.items).toEqual([{ invoiceItemId: "a", qty: 1, amount: 100 }]);
    expect(r.price).toBe(100);
  });
  it("money-neutral vs master: 1 free + 10 paid ($100), return 1 = $9.09 (pooled average), itemised on the PAID line", () => {
    const r = planProductRefund([L("free", 0, 1), L("paid", 100, 10)], new Map(), "p", 1);
    expect(r.price).toBe(9.09);
    expect(r.items).toEqual([{ invoiceItemId: "paid", qty: 1, amount: 9.09 }]);
  });
  it("return all 11 = $100: the paid line takes $100 for 10 pcs and the free line takes its 1 pc at $0", () => {
    const r = planProductRefund([L("free", 0, 1), L("paid", 100, 10)], new Map(), "p", 11);
    expect(r.amount).toBe(100);
    expect(r.items).toEqual([
      { invoiceItemId: "paid", qty: 10, amount: 100 },
      { invoiceItemId: "free", qty: 1, amount: 0 },
    ]);
  });
  it("5@$10 + 5@$8: return 10 = $90 as 50/40; return 3 = $27 on line 1", () => {
    const lines = [L("l1", 50, 5), L("l2", 40, 5)];
    expect(planProductRefund(lines, new Map(), "p", 10).items).toEqual([
      { invoiceItemId: "l1", qty: 5, amount: 50 },
      { invoiceItemId: "l2", qty: 5, amount: 40 },
    ]);
    expect(planProductRefund(lines, new Map(), "p", 3).items).toEqual([
      { invoiceItemId: "l1", qty: 3, amount: 27 },
    ]);
  });
  it("items ALWAYS sum to the price: a prior 3@$5 credit on a $100/10 line, return 7 = $70 (never the $85 rest)", () => {
    const r = planProductRefund([L("x", 100, 10)], credit({ x: [15, 3, 1] }), "p", 7);
    expect(r.price).toBe(70);
    expect(r.amount).toBe(70);
    expect(r.items).toEqual([{ invoiceItemId: "x", qty: 7, amount: 70 }]);
  });
  it("REFUND mode never clips: a prior $33.33 credit leaves $66.67 of a $100 line, so returning it whole is a refusal", () => {
    const r = planProductRefund([A, B], credit({ a: [33.33, 0.333, 1] }), "pa", 1);
    expect(r.items).toEqual([]);
    expect(r.refusal).toMatchObject({
      productId: "pa",
      requestedAmount: 100,
      remainingAmount: 66.67,
      requestedQty: 1,
      remainingQty: 0.667,
    });
  });
  it("a prior credit that ate a line's money => refused even though qty is left ($100/10pc, $50 credited as 1pc, 9 pcs = $90)", () => {
    const r = planProductRefund([L("x", 100, 10)], credit({ x: [50, 1, 1] }), "p", 9);
    expect(r.items).toEqual([]);
    expect(r.refusal).toMatchObject({
      requestedAmount: 90,
      remainingAmount: 50,
      requestedQty: 9,
      remainingQty: 9,
    });
  });
  it("a qty beyond the lines' qty room is a refusal", () => {
    const r = planProductRefund([L("x", 100, 10)], credit({ x: [0, 8, 1] }), "p", 3);
    expect(r.refusal).toMatchObject({ requestedQty: 3, remainingQty: 2 });
  });
  it("COUNT mode (the legacy history term) clips to what the lines have left and never refuses", () => {
    const r = planProductRefund([A, B], credit({ a: [33.33, 0.333, 1] }), "pa", 1, "count");
    expect(r.refusal).toBeUndefined();
    expect(r.items).toEqual([{ invoiceItemId: "a", qty: 0.667, amount: 66.67 }]);
  });
  it("rounding drift: six 1/6 refunds of a $1.00 line all pass, and the sum never exceeds the line", () => {
    const line = L("d", 1, 6);
    let credited: ReadonlyMap<string, { amount: number; qty: number; items?: number }> = new Map();
    for (let k = 0; k < 6; k++) {
      const r = planProductRefund([line], credited, "p", 1);
      expect(r.refusal).toBeUndefined();
      credited = addCredits(credited, r.items);
    }
    expect(credited.get("d")?.qty).toBe(6);
    expect(credited.get("d")!.amount).toBeLessThanOrEqual(1);
  });
  it("a fully credited line takes nothing: the whole request is refused (B's slack is never borrowed)", () => {
    const r = planProductRefund([A, B], credit({ a: [100, 1, 1] }), "pa", 1);
    expect(r.refusal).toBeDefined();
  });
  it("an all-free product prices at $0 and still itemises its qty at amount 0", () => {
    const r = planProductRefund([L("f", 0, 2)], new Map(), "p", 1);
    expect(r.price).toBe(0);
    expect(r.items).toEqual([{ invoiceItemId: "f", qty: 1, amount: 0 }]);
  });
  it("product-level cap: line 1 short of money but line 2 has room is NOT refused; the remainder lands on line 2", () => {
    const lines = [L("l1", 100, 5), L("l2", 100, 5)];
    const r = planProductRefund(lines, credit({ l1: [90, 1, 1] }), "p", 5);
    expect(r.refusal).toBeUndefined();
    expect(r.amount).toBe(100);
    expect(r.items.reduce((n, i) => n + i.amount, 0)).toBe(100);
    expect(r.items.find((i) => i.invoiceItemId === "l1")!.amount).toBeLessThanOrEqual(10);
  });
  it("B1: $100/10pc with a prior $9/qty-9 credit, a 1-pc return mints $10 (P), not the $91 rest", () => {
    const r = planProductRefund([L("x", 100, 10)], credit({ x: [9, 9, 1] }), "p", 1);
    expect(r.items).toEqual([{ invoiceItemId: "x", qty: 1, amount: 10 }]);
  });
  it("the refusal's `requested` is the pooled price, not the first line's (a free first line)", () => {
    const r = planProductRefund(
      [L("free", 0, 1), L("paid", 100, 10)],
      credit({ paid: [95, 9, 1] }),
      "p",
      10,
    );
    expect(r.refusal).toMatchObject({ requestedAmount: 90.91, remainingAmount: 5 });
  });
  it("a later PAID line can take pieces at amount 0 (the pooled price fits the first line): $20/2pc + $4/2pc, 3 pcs = $18", () => {
    const r = planProductRefund([L("a", 20, 2), L("b", 4, 2)], new Map(), "p", 3);
    expect(r.price).toBe(18);
    expect(r.items).toEqual([
      { invoiceItemId: "a", qty: 2, amount: 18 },
      { invoiceItemId: "b", qty: 1, amount: 0 },
    ]);
  });
  it("preview == mint: the price with nothing credited equals the minted sum", () => {
    const lines = [L("l1", 50, 5), L("l2", 40, 5), L("f", 0, 1)];
    for (const q of [1, 3, 5, 7, 11]) {
      const r = planProductRefund(lines, new Map(), "p", q);
      expect(r.amount).toBe(r.price);
    }
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
    expect(out.get("a")).toMatchObject({ amount: 33.33, qty: 0.333 });
    expect(out.get("b")).toMatchObject({ amount: 100, qty: 1 }); // the legacy refund of B's whole line
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
    expect(out.get("a")).toMatchObject({ amount: 100, qty: 1 });
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
    // the legacy (credit-note-linked) lookup is skipped; only SA-727's external-refund read touches `return`
    expect(db.return.findMany).not.toHaveBeenCalledWith({
      where: expect.objectContaining({ creditNoteId: { in: expect.anything() } }),
    });
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

describe("inline term (B948, SA-628a (c)): an inline return's ReturnItems count against the source line", () => {
  const db = (inline: unknown[]) => ({
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: { findMany: jest.fn().mockResolvedValue([]) },
    return: { findMany: jest.fn() },
    returnItem: { findMany: jest.fn().mockResolvedValue(inline) },
  });
  it("counts the net subtotal + qty of a live inline return keyed on sourceInvoiceItemId (cancelled/rejected excluded in the query)", async () => {
    const d = db([{ sourceInvoiceItemId: "a", qty: 1, subtotal: 100 }]);
    const out = await loadLineCredits(d, "inv", [A, B]);
    expect(out.get("a")).toMatchObject({ amount: 100, qty: 1 });
    expect(d.returnItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          sourceInvoiceItemId: { in: ["a", "b"] },
          return: { kind: "INLINE", status: { notIn: ["CANCELLED", "REJECTED"] } },
        },
      }),
    );
  });
  it("converts the pieces to the line's own qty axis (a boxed selling-unit line of 2 boxes x 12: 12 pieces = 1 box)", async () => {
    const boxed: HeadroomLine = {
      id: "bx",
      productId: "p",
      subtotal: 120,
      qty: 2,
      piecesPerQty: 12,
    };
    const out = await loadLineCredits(
      db([{ sourceInvoiceItemId: "bx", qty: 12, subtotal: 60 }]),
      "inv",
      [boxed],
    );
    expect(out.get("bx")).toMatchObject({ amount: 60, qty: 1 });
  });
  it("a credit note's item AND an inline return on one line add up (the $160-on-$100 repro)", async () => {
    const d = db([{ sourceInvoiceItemId: "a", qty: 1, subtotal: 100 }]);
    d.creditNoteItem.findMany.mockResolvedValue([{ invoiceItemId: "a", amount: 60, qty: 0.6 }]);
    const out = await loadLineCredits(d, "inv", [A]);
    expect(out.get("a")).toMatchObject({ amount: 160, qty: 1.6 });
  });
  it("lineTakeRefusal: the inline capture after a $60 credit note refuses a whole-line $100 take; a $40 take fits", () => {
    const credited = new Map([["a", { amount: 60, qty: 0.6, items: 1 }]]);
    expect(lineTakeRefusal(A, credited, { qty: 1, amount: 100 })).toMatchObject({
      requestedAmount: 100,
      remainingAmount: 40,
    });
    expect(lineTakeRefusal(A, credited, { qty: 0.4, amount: 40 })).toBeNull();
  });
  it("lineTakeRefusal: a free line binds on qty only", () => {
    const free: HeadroomLine = { id: "f", productId: "p", subtotal: 0, qty: 2 };
    expect(lineTakeRefusal(free, new Map(), { qty: 2, amount: 0 })).toBeNull();
    expect(lineTakeRefusal(free, new Map(), { qty: 3, amount: 0 })).not.toBeNull();
  });
});

describe("piecesPerQtyOf resolves the pack like the inline pricing", () => {
  it("box-split => 1; own snapshot; own split; product pack; else 1", () => {
    expect(piecesPerQtyOf({ boxes: 2, unitsPerBox: 12 })).toBe(1);
    expect(piecesPerQtyOf({ unitsPerBox: 12 })).toBe(12);
    expect(piecesPerQtyOf({ qty: 24, boxes: null, product: { unitsPerBox: 6 } })).toBe(6);
    expect(piecesPerQtyOf({ qty: 2, product: { unitsPerBox: 12 } })).toBe(12);
    expect(piecesPerQtyOf({ qty: 2 })).toBe(1);
  });
});

describe("SA-727 (M4): a STANDARD return resolved by an EXTERNAL_REFUND counts against its lines (no credit note mints it)", () => {
  const extReturn = [
    { orderId: "o1", refundMethod: "EXTERNAL_REFUND", items: [{ productId: "pa", qty: 1 }] },
  ];
  const base = (over: Record<string, unknown> = {}) => ({
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    creditNote: { findMany: jest.fn().mockResolvedValue([]) },
    invoice: {
      findFirst: jest.fn().mockResolvedValue({ orderId: "o1" }),
      count: jest.fn().mockResolvedValue(1),
    },
    return: { findMany: jest.fn().mockResolvedValue(extReturn) },
    ...over,
  });
  it("a sole-invoice order: the externally refunded line has no headroom left for a credit note", async () => {
    const d = base();
    const out = await loadLineCredits(d, "inv", [A, B]);
    expect(out.get("a")).toMatchObject({ amount: 100, qty: 1 });
    expect(out.get("b")).toBeUndefined();
    expect(d.return.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          kind: { not: "INLINE" },
          refundMethod: "EXTERNAL_REFUND",
          creditNoteId: null,
          status: "REFUNDED",
          order: { invoices: { some: { id: "inv" } } },
        }),
      }),
    );
  });
  it("with 2+ creditable invoices the per-invoice term leaves it to the order pool (no double attribution)", async () => {
    const d = base({
      invoice: {
        findFirst: jest.fn().mockResolvedValue({ orderId: "o1" }),
        count: jest.fn().mockResolvedValue(2),
      },
    });
    expect((await loadLineCredits(d, "inv", [A, B])).size).toBe(0);
  });
  it("the order pool counts it once, pooled by product", async () => {
    const d = {
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      creditNote: { findMany: jest.fn().mockResolvedValue([]) },
      invoice: {
        findMany: jest.fn().mockResolvedValue([
          { id: "i1", items: [{ id: "a", productId: "pa", subtotal: 100, qty: 1 }] },
          { id: "i2", items: [{ id: "b", productId: "pb", subtotal: 100, qty: 1 }] },
        ]),
      },
      return: { findMany: jest.fn().mockResolvedValue(extReturn) },
    };
    const pool = await loadOrderPool(d, "o1");
    expect(pool.credited.get("a")).toMatchObject({ amount: 100, qty: 1 });
    expect(pool.credited.get("b")).toBeUndefined();
  });
  it("an INLINE return counts through the inline term whatever its resolution: the query has no refundMethod/creditNote filter, so an EXTERNAL_REFUND one is in", async () => {
    const d = {
      creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
      creditNote: { findMany: jest.fn().mockResolvedValue([]) },
      return: { findMany: jest.fn().mockResolvedValue([]) },
      returnItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ sourceInvoiceItemId: "a", qty: 1, subtotal: 100 }]),
      },
    };
    const out = await loadLineCredits(d, "inv", [A]);
    expect(out.get("a")).toMatchObject({ amount: 100, qty: 1 });
    const where = d.returnItem.findMany.mock.calls[0][0].where;
    expect(where.return).toEqual({ kind: "INLINE", status: { notIn: ["CANCELLED", "REJECTED"] } });
    expect(JSON.stringify(where)).not.toMatch(/refundMethod|creditNoteId/);
  });
});

describe("SA-727a: headroom CLAMPS at 0 - a legacy line both refunded and credited only blocks NEW credits, reads never throw", () => {
  // $100 / 1 pc line that was credited $160 / 1.6 pc in total (a note item of $60 plus an inline return of $100)
  const over = credit({ a: [160, 1.6, 2] });
  it("lineTakeRefusal: remaining amount and qty are 0, never negative; any take is refused", () => {
    const r = lineTakeRefusal(A, over, { qty: 0.1, amount: 1 });
    expect(r).toMatchObject({ remainingAmount: 0, remainingQty: 0 });
    expect(r!.remainingAmount).toBeGreaterThanOrEqual(0);
    expect(r!.remainingQty).toBeGreaterThanOrEqual(0);
  });
  it("planProductRefund (refund mode): a refusal with remaining 0, no throw; count mode takes nothing and does not throw", () => {
    const r = planProductRefund([A, B], over, "pa", 1);
    expect(r.refusal).toMatchObject({ remainingAmount: 0, remainingQty: 0 });
    const c = planProductRefund([A, B], over, "pa", 1, "count");
    expect(c.items.every((i) => i.amount >= 0 && i.qty >= 0)).toBe(true);
    expect(c.amount).toBe(0);
  });
  it("pooledTakeRefusal: the pool's remaining is 0, never negative", async () => {
    const { pooledTakeRefusal } = await import("./line-credit-headroom");
    const pool = { invoiceCount: 2, lines: [A, B], credited: over };
    const r = pooledTakeRefusal(pool, "pa", { amount: 1, qty: 0.1 });
    expect(r).toMatchObject({ remainingAmount: 0, remainingQty: 0 });
  });
  it("loadLineCredits: a line already over-credited by items and an inline return reads fine (no throw) and an external refund adds nothing past the line", async () => {
    const d = {
      creditNoteItem: {
        findMany: jest.fn().mockResolvedValue([{ invoiceItemId: "a", amount: 60, qty: 0.6 }]),
      },
      creditNote: { findMany: jest.fn().mockResolvedValue([]) },
      returnItem: {
        findMany: jest
          .fn()
          .mockResolvedValue([{ sourceInvoiceItemId: "a", qty: 1, subtotal: 100 }]),
      },
      invoice: {
        findFirst: jest.fn().mockResolvedValue({ orderId: "o1" }),
        count: jest.fn().mockResolvedValue(1),
      },
      return: {
        findMany: jest.fn().mockResolvedValue([
          {
            orderId: "o1",
            refundMethod: "EXTERNAL_REFUND",
            items: [{ productId: "pa", qty: 1 }],
          },
        ]),
      },
    };
    const out = await loadLineCredits(d, "inv", [A, B]);
    expect(out.get("a")).toMatchObject({ amount: 160, qty: 1.6 }); // the external refund found no room on A: adds 0
    expect(out.get("b")).toBeUndefined();
  });
});
