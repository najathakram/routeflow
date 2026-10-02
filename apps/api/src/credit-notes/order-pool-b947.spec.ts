import {
  countCreditableInvoices,
  lineTakeRefusal,
  loadOrderPool,
  lockOrderPoolRows,
  pooledRefundRefusal,
  pooledTakeRefusal,
} from "./line-credit-headroom";

/**
 * B947: the ORDER POOL. One pool per product across ALL the order's creditable invoices: credit note items and inline items on
 * its lines, plus the itemless refund notes of the order (on any creditable invoice or order-linked), attributed through their
 * Return's items and pooled across the combined lines. The real-Postgres proof is credit-return-line-cap-multi-invoice.db.spec.ts.
 */
const line = (id: string, productId: string, subtotal = 100, qty = 1) => ({
  id,
  productId,
  subtotal,
  qty,
  boxes: null,
  unitsPerBox: null,
  pieces: null,
  product: { unitsPerBox: null },
});
interface Fake {
  invoices: Array<{ id: string; items: any[] }>;
  cnItems?: Array<{ invoiceId: string; invoiceItemId: string; amount: number; qty: number }>;
  itemless?: Array<{ id: string; returnItems: Array<{ productId: string; qty: number }> }>;
  inline?: Array<{ sourceInvoiceItemId: string; qty: number; subtotal: number }>;
}
function fakeDb(f: Fake) {
  const exec = jest.fn().mockResolvedValue(0);
  const db: any = {
    $executeRaw: exec,
    invoice: { findMany: jest.fn().mockResolvedValue(f.invoices) },
    creditNoteItem: {
      findMany: jest.fn(async (args: any) =>
        (f.cnItems ?? []).filter(
          (r) =>
            args.where.creditNote.invoiceId === r.invoiceId &&
            args.where.invoiceItemId.in.includes(r.invoiceItemId),
        ),
      ),
    },
    returnItem: {
      findMany: jest.fn(async (args: any) =>
        (f.inline ?? []).filter((r) =>
          args.where.sourceInvoiceItemId.in.includes(r.sourceInvoiceItemId),
        ),
      ),
    },
    creditNote: {
      findMany: jest.fn().mockResolvedValue((f.itemless ?? []).map((n) => ({ id: n.id }))),
    },
    return: {
      findMany: jest.fn(async (args: any) =>
        (f.itemless ?? [])
          .filter((n) => args.where.creditNoteId.in.includes(n.id))
          .map((n) => ({ items: n.returnItems })),
      ),
    },
  };
  return { db, exec };
}
const X = { id: "inv-x", items: [line("x-a", "pa"), line("x-b", "pb")] };
const Y = { id: "inv-y", items: [line("y-c", "pc")] };

describe("B947 order pool", () => {
  it("counts a CN item on X's line A against a refund of A (the refund's lump sum goes on Y)", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      cnItems: [{ invoiceId: "inv-x", invoiceItemId: "x-a", amount: 100, qty: 1 }],
    });
    const pool = await loadOrderPool(db, "ord-1");
    expect(pool.invoiceCount).toBe(2);
    expect(pooledRefundRefusal(pool, "pa", 1)).toMatchObject({
      remainingAmount: 0,
      remainingQty: 0,
    });
    expect(pooledRefundRefusal(pool, "pb", 1)).toBeNull(); // another product is unaffected
    expect(pooledRefundRefusal(pool, "pc", 1)).toBeNull();
  });

  it("an itemless refund lump (on the LATEST invoice Y) of product A counts against A's line on X: a second refund and a CN item on A are refused", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      itemless: [{ id: "cn-lump", returnItems: [{ productId: "pa", qty: 1 }] }],
    });
    const pool = await loadOrderPool(db, "ord-1");
    expect(pooledRefundRefusal(pool, "pa", 1)).not.toBeNull();
    expect(pooledTakeRefusal(pool, "pa", { amount: 100 })).not.toBeNull();
    expect(pooledTakeRefusal(pool, "pb", { amount: 100 })).toBeNull(); // a different product on X stays unaffected
  });

  it("P billed on BOTH invoices is pooled and counted ONCE: 4 of 10 on X + 6 of 10 on Y; a 10-piece refund fits only when nothing is credited, and a lump of 6 leaves exactly 4", async () => {
    const XP = { id: "inv-x", items: [line("x-p", "pp", 60, 6)] };
    const YP = { id: "inv-y", items: [line("y-p", "pp", 40, 4)] };
    const clean = await loadOrderPool(fakeDb({ invoices: [XP, YP] }).db, "ord-1");
    expect(pooledRefundRefusal(clean, "pp", 10)).toBeNull();
    expect(pooledRefundRefusal(clean, "pp", 11)).toBeNull(); // a refund is capped at the billed qty (min(returned, billed))
    const lumped = await loadOrderPool(
      fakeDb({
        invoices: [XP, YP],
        itemless: [{ id: "cn-lump", returnItems: [{ productId: "pp", qty: 6 }] }],
      }).db,
      "ord-1",
    );
    expect(pooledRefundRefusal(lumped, "pp", 4)).toBeNull();
    expect(pooledRefundRefusal(lumped, "pp", 5)).not.toBeNull(); // counted once, not twice
  });

  it("an inline return sourced to X's line pools with a refund of the same product on the order", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      inline: [{ sourceInvoiceItemId: "x-a", qty: 1, subtotal: 100 }],
    });
    const pool = await loadOrderPool(db, "ord-1");
    expect(pooledRefundRefusal(pool, "pa", 1)).not.toBeNull();
  });

  it("a manual itemless note (no Return) is never counted", async () => {
    const { db } = fakeDb({ invoices: [X, Y], itemless: [{ id: "cn-manual", returnItems: [] }] });
    const pool = await loadOrderPool(db, "ord-1");
    expect(pooledRefundRefusal(pool, "pa", 1)).toBeNull();
  });

  it("lockOrderPoolRows: Order, then EVERY creditable invoice id-sorted, FOR UPDATE, before any credit is read; none with one creditable invoice or no order", async () => {
    const f = fakeDb({ invoices: [Y, X] });
    const order: string[] = [];
    f.db.invoice.findFirst = jest.fn().mockResolvedValue({ orderId: "ord-1" });
    f.exec.mockImplementation((s: TemplateStringsArray, v: unknown) => {
      order.push(`${s.join("?").match(/FROM "(\w+)"/)![1]}:${v}`);
      return Promise.resolve(0);
    });
    await lockOrderPoolRows(f.db, "inv-x", "t-1");
    expect(order).toEqual(["Order:ord-1", "Invoice:inv-y", "Invoice:inv-x"]);
    // N4: every lock is tenant-scoped (the tenant id is the SECOND bound value)
    for (const call of f.exec.mock.calls) expect(call[2]).toBe("t-1");
    // the sort is the DB's (`orderBy id asc`): the fake returns them as given, the query asks for ascending ids
    expect(f.db.invoice.findMany.mock.calls[0][0].orderBy).toEqual([{ id: "asc" }]);
    const single = fakeDb({ invoices: [X] });
    single.db.invoice.findFirst = jest.fn().mockResolvedValue({ orderId: "ord-1" });
    await lockOrderPoolRows(single.db, "inv-x", "t-1");
    expect(single.exec).not.toHaveBeenCalled(); // one creditable invoice: the single-invoice lock stays enough
    const noOrder = fakeDb({ invoices: [X, Y] });
    noOrder.db.invoice.findFirst = jest.fn().mockResolvedValue({ orderId: null });
    await lockOrderPoolRows(noOrder.db, "inv-x", "t-1");
    expect(noOrder.exec).not.toHaveBeenCalled();
  });

  it("SA-628g: lockOrderPoolRows FAILS CLOSED without a tenant (a null tenant in the lock predicate would lock NOTHING)", async () => {
    const f = fakeDb({ invoices: [X, Y] });
    f.db.invoice.findFirst = jest.fn().mockResolvedValue({ orderId: "ord-1" });
    await expect(lockOrderPoolRows(f.db, "inv-x", null)).rejects.toThrow(/tenant/i);
    expect(f.exec).not.toHaveBeenCalled();
    expect(f.db.invoice.findFirst).not.toHaveBeenCalled(); // refused before any read
  });

  it("loadOrderPool itself takes NO lock (the writers lock first, so the lock order never inverts)", async () => {
    const f = fakeDb({ invoices: [X, Y] });
    await loadOrderPool(f.db, "ord-1");
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("an INLINE return is counted ONCE (its items carry the source line): the itemless term skips INLINE returns", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      inline: [{ sourceInvoiceItemId: "x-a", qty: 1, subtotal: 100 }],
      itemless: [{ id: "cn-inline", returnItems: [{ productId: "pa", qty: 1 }] }],
    });
    await loadOrderPool(db, "ord-1");
    expect(db.return.findMany.mock.calls[0][0].where.kind).toEqual({ not: "INLINE" });
  });

  it("N2: the pooled qty is in PIECES across lines with different units: a 2-box (x12) line and a 12-piece line pool to 36 pieces, not 14", async () => {
    const boxed = { ...line("m-box", "pm", 240, 2), unitsPerBox: 12 }; // qty is BOXES: 24 pieces
    const loose = line("m-pcs", "pm", 60, 12); // qty is PIECES: 12
    const pool = await loadOrderPool(
      fakeDb({
        invoices: [
          { id: "inv-m1", items: [boxed] },
          { id: "inv-m2", items: [loose] },
        ],
      }).db,
      "ord-1",
    );
    expect(pooledTakeRefusal(pool, "pm", { amount: 1, qty: 30 })).toBeNull(); // adding raw qty (2 + 12 = 14) would refuse this
    const over = pooledTakeRefusal(pool, "pm", { amount: 1, qty: 37 });
    expect(over).toMatchObject({ remainingQty: 36, requestedQty: 37 });
  });

  it("N2: credited boxes are converted too: 1 of 2 boxes credited leaves 24 pieces (12 + 12), not 13", async () => {
    const boxed = { ...line("m-box", "pm", 240, 2), unitsPerBox: 12 };
    const loose = line("m-pcs", "pm", 60, 12);
    const pool = await loadOrderPool(
      fakeDb({
        invoices: [
          { id: "inv-m1", items: [boxed] },
          { id: "inv-m2", items: [loose] },
        ],
        cnItems: [{ invoiceId: "inv-m1", invoiceItemId: "m-box", amount: 120, qty: 1 }],
      }).db,
      "ord-1",
    );
    expect(pooledTakeRefusal(pool, "pm", { amount: 1, qty: 24 })).toBeNull();
    expect(pooledTakeRefusal(pool, "pm", { amount: 1, qty: 25 })).toMatchObject({
      remainingQty: 24,
    });
  });

  it("OPUS r4: no round3 before the pieces multiply: 2 boxes x12 with 2 pieces returned inline leaves 22.0 pieces, so taking 22 passes and 23 is refused", async () => {
    const boxed = { ...line("r-box", "pr", 240, 2), unitsPerBox: 12 };
    const pool = await loadOrderPool(
      fakeDb({
        invoices: [
          { id: "inv-r1", items: [boxed] },
          { id: "inv-r2", items: [line("r-other", "po")] },
        ],
        inline: [{ sourceInvoiceItemId: "r-box", qty: 2, subtotal: 20 }], // 2 PIECES = 2/12 box (0.16666...)
      }).db,
      "ord-1",
    );
    expect(pooledTakeRefusal(pool, "pr", { amount: 1, qty: 22 })).toBeNull(); // the old code computed 21.996 and refused
    expect(pooledTakeRefusal(pool, "pr", { amount: 1, qty: 23 })).toMatchObject({
      qtyUnit: "pieces",
    });
  });

  it("OPUS r4: an amount-only credit note stores qty 0.167 (3 decimals): the tolerance scales by pieces-per-qty, so 22 passes and 23 is refused", async () => {
    const boxed = { ...line("r-box", "pr", 240, 2), unitsPerBox: 12 };
    const pool = await loadOrderPool(
      fakeDb({
        invoices: [
          { id: "inv-r1", items: [boxed] },
          { id: "inv-r2", items: [line("r-other", "po")] },
        ],
        cnItems: [{ invoiceId: "inv-r1", invoiceItemId: "r-box", amount: 20, qty: 0.167 }],
      }).db,
      "ord-1",
    );
    expect(pooledTakeRefusal(pool, "pr", { amount: 1, qty: 22 })).toBeNull(); // room 21.996 + tolerance 0.012
    expect(pooledTakeRefusal(pool, "pr", { amount: 1, qty: 23 })).not.toBeNull();
  });

  it("OPUS r4 N2: the refusal states its qty unit: the pool says pieces, the per-invoice take says line", async () => {
    const pool = await loadOrderPool(fakeDb({ invoices: [X, Y] }).db, "ord-1");
    expect(pooledTakeRefusal(pool, "pa", { amount: 500 })).toMatchObject({ qtyUnit: "pieces" });
    expect(
      lineTakeRefusal({ id: "l", productId: "pa", subtotal: 100, qty: 1 }, new Map(), {
        qty: 2,
        amount: 10,
      }),
    ).toMatchObject({ qtyUnit: "line" });
  });

  it("qty binds a credit note take only when one is GIVEN: 10 pieces of a fully-credited product at $0.01 is refused", async () => {
    const XP = { id: "inv-x", items: [line("x-p", "pp", 100, 10)] };
    const YP = { id: "inv-y", items: [line("y-p", "pp", 100, 10)] };
    const pool = await loadOrderPool(
      fakeDb({
        invoices: [XP, YP],
        itemless: [{ id: "cn-lump", returnItems: [{ productId: "pp", qty: 10 }] }],
      }).db,
      "ord-1",
    );
    expect(pooledTakeRefusal(pool, "pp", { amount: 0.01, qty: 11 })).not.toBeNull();
    expect(pooledTakeRefusal(pool, "pp", { amount: 0.01, qty: null })).toBeNull(); // amount-only: money rules
  });

  it("N7: the itemless term excludes VOID notes in the query (a missing VOID filter turns this red)", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      itemless: [{ id: "cn-lump", returnItems: [{ productId: "pa", qty: 1 }] }],
    });
    await loadOrderPool(db, "ord-1");
    expect(db.creditNote.findMany.mock.calls[0][0].where).toMatchObject({
      status: { not: "VOID" },
      items: { none: {} },
    });
    expect(db.creditNoteItem.findMany.mock.calls[0][0].where.creditNote).toMatchObject({
      status: { not: "VOID" },
    });
  });

  it("N2: the Return read is scoped to THIS order (another order's refund lump merely queued to apply here is not attributed)", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      itemless: [{ id: "cn-foreign", returnItems: [{ productId: "pa", qty: 1 }] }],
    });
    await loadOrderPool(db, "ord-1");
    expect(db.return.findMany.mock.calls[0][0].where).toMatchObject({ orderId: "ord-1" });
  });

  it("N6: countCreditableInvoices asks only for the count with the same creditable predicate", async () => {
    const db: any = { invoice: { count: jest.fn().mockResolvedValue(1) } };
    expect(await countCreditableInvoices(db, "ord-1")).toBe(1);
    expect(db.invoice.count).toHaveBeenCalledWith({
      where: { orderId: "ord-1", status: { notIn: ["VOID", "WRITTEN_OFF"] } },
    });
  });

  it("the creditable set is the one predicate priceReturn uses (VOID / WRITTEN_OFF are excluded in the query)", async () => {
    const { db } = fakeDb({ invoices: [X, Y] });
    await loadOrderPool(db, "ord-1");
    expect(db.invoice.findMany.mock.calls[0][0].where).toEqual({
      orderId: "ord-1",
      status: { notIn: ["VOID", "WRITTEN_OFF"] },
    });
  });

  it("a CN take within the pooled room passes; one cent over (beyond the tolerance) is refused", async () => {
    const { db } = fakeDb({
      invoices: [X, Y],
      cnItems: [{ invoiceId: "inv-x", invoiceItemId: "x-a", amount: 60, qty: 0.6 }],
    });
    const pool = await loadOrderPool(db, "ord-1");
    expect(pooledTakeRefusal(pool, "pa", { amount: 40 })).toBeNull();
    expect(pooledTakeRefusal(pool, "pa", { amount: 40.02 })).not.toBeNull();
  });
});
