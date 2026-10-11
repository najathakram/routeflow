import {
  lineGrossValue,
  poolKey,
  refundableRefusal,
  refundableRemainder,
  creditableGroupInvoiceIds,
} from "./refundable-remainder";

/**
 * SA-773 - the formula of the ONE refundable remainder, over rows an in-memory transaction hands back. The status and exclusion
 * rules run in code (not in a where), so a fixture row of the wrong status is what proves each rule. The real queries run in
 * `refundable-remainder.db.spec.ts`.
 */

type Row = Record<string, any>;
interface Fixture {
  invoices: Row[];
  standardReturns?: Row[];
  inlineItems?: Row[];
  cnItems?: Row[];
  amountOnly?: Row[];
  /** every return that owns a credit note (any status): { id, creditNoteId, status } */
  linkedReturns?: Row[];
  orderLines?: Row[];
}

const line = (
  id: string,
  productId: string,
  qty: number,
  subtotal: number,
  extra: Row = {},
): Row => ({
  id,
  productId,
  qty,
  subtotal,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  product: { unitsPerBox: null },
  ...extra,
});
const invoice = (id: string, orderId: string | null, total: number, items: Row[]): Row => ({
  id,
  orderId,
  total,
  status: "SENT",
  items,
});

function fakeTx(f: Fixture) {
  const used: string[] = [];
  const tx = {
    invoice: { findMany: jest.fn(async () => (used.push("invoice"), f.invoices)) },
    return: {
      findMany: jest.fn(async (args: any) => {
        if (args?.where?.creditNoteId) {
          used.push("return.link");
          const wanted: string[] = args.where.creditNoteId.in;
          return (f.linkedReturns ?? []).filter((r) => wanted.includes(r.creditNoteId));
        }
        used.push("return");
        return f.standardReturns ?? [];
      }),
    },
    returnItem: { findMany: jest.fn(async () => (used.push("returnItem"), f.inlineItems ?? [])) },
    creditNoteItem: { findMany: jest.fn(async () => (used.push("cnItem"), f.cnItems ?? [])) },
    creditNote: { findMany: jest.fn(async () => (used.push("cn"), f.amountOnly ?? [])) },
    orderItem: { findMany: jest.fn(async () => f.orderLines ?? []) },
    invoiceItem: { findMany: jest.fn(async () => []) },
  };
  return Object.assign(tx, { used });
}

const poolOf = (rem: Awaited<ReturnType<typeof refundableRemainder>>, inv: string, prod: string) =>
  rem.byInvoiceProduct.get(poolKey(inv, prod));

describe("refundableRemainder (SA-773): the one formula", () => {
  it("a line's gross value is its net, its tax at the line's stored rate and its category tax, in cents", () => {
    expect(lineGrossValue({ subtotal: 33.33, taxRate: 0.0825, categoryTaxAmount: 1.5 })).toBe(
      37.58,
    );
    expect(lineGrossValue({ subtotal: 100, taxRate: 0, categoryTaxAmount: 0 })).toBe(100);
  });

  it("nothing credited: the remainder is the billed qty (pieces) and gross value", async () => {
    const tx = fakeTx({
      invoices: [
        invoice("i1", "o1", 112, [
          line("l1", "pA", 10, 100, { taxRate: 0.1, categoryTaxAmount: 2 }),
        ]),
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 10, value: 112 });
    expect(rem.byInvoice.get("i1")).toMatchObject({ value: 112 });
  });

  it("no invoice rows, or none ids: an empty answer and no further reads", async () => {
    const tx = fakeTx({ invoices: [] });
    expect((await refundableRemainder(tx, { invoiceIds: [] })).byInvoiceProduct.size).toBe(0);
    expect((await refundableRemainder(tx, { invoiceIds: ["i1"] })).byInvoiceProduct.size).toBe(0);
    expect(tx.used).toEqual(["invoice"]);
  });

  it("(b) a standalone credit note item takes its qty and its GROSS value ($20 of goods at 10% tax + category tax)", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 110, [line("l1", "pA", 10, 100, { taxRate: 0.1 })])],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cn1",
          qty: 2,
          amount: 20,
          categoryTax: 0.5,
          creditNote: { status: "ISSUED" },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    // 20 + 0.5 + 20 x 0.1 = 22.5
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 8, value: 87.5 });
    expect(rem.byInvoice.get("i1")?.value).toBe(87.5);
  });

  it("a partial credit note ($8 of a $20 line) leaves $12", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 20, [line("l1", "pA", 4, 20)])],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cn1",
          qty: 1.6,
          amount: 8,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 2.4, value: 12 });
  });

  it("a VOID credit note item is not netted", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 20, [line("l1", "pA", 4, 20)])],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cn1",
          qty: 4,
          amount: 20,
          categoryTax: 0,
          creditNote: { status: "VOID" },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 4, value: 20 });
  });

  it("(a) a REJECTED or CANCELLED return is not netted; every live status is, at its stored qty (fail closed)", async () => {
    const mk = (status: string, id: string) => ({
      id,
      orderId: "o1",
      kind: "STANDARD",
      status,
      items: [{ productId: "pA", qty: 1 }],
    });
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)])],
      standardReturns: [
        mk("REJECTED", "r1"),
        mk("CANCELLED", "r2"),
        mk("PENDING", "r3"),
        mk("APPROVED", "r4"),
        mk("RECEIVED", "r5"),
        mk("REFUNDED", "r6"),
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    // four live returns x 1 piece, priced at the pool's gross average ($10)
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 6, value: 60 });
  });

  it("a STANDARD return's qty is in the order line's own unit: a line with a box split already counts pieces", async () => {
    const tx = fakeTx({
      invoices: [
        invoice("i1", "o1", 120, [
          line("l1", "pA", 24, 120, { boxes: 2, pieces: 0, unitsPerBox: 12 }),
        ]),
      ],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "RECEIVED",
          items: [{ productId: "pA", qty: 1 }],
        },
      ],
      orderLines: [
        {
          id: "ol1",
          productId: "pA",
          qty: 24,
          status: "OPEN",
          position: 1,
          boxes: 2,
          pieces: 0,
          unitsPerBox: 12,
          unitLabel: null,
          product: { unitsPerBox: 12 },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 23, value: 115 });
  });

  it("a STANDARD return of a boxed line with no pack proof counts the pool's single pieces-per-box (2 boxes of 12)", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 120, [line("l1", "pA", 2, 120, { unitsPerBox: 12 })])],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "RECEIVED",
          items: [{ productId: "pA", qty: 1 }],
        },
      ],
      orderLines: [
        {
          id: "ol1",
          productId: "pA",
          qty: 2,
          status: "OPEN",
          position: 1,
          boxes: null,
          pieces: null,
          unitsPerBox: 12,
          unitLabel: null,
          product: { unitsPerBox: 12 },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    // 1 box = 12 of 24 pieces, half of $120
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 12, value: 60 });
  });

  it("(a) an INLINE return counts its stored item qty (pieces) and money (subtotal + tax + category tax)", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 110, [line("l1", "pA", 10, 100, { taxRate: 0.1 })])],
      inlineItems: [
        {
          productId: "pA",
          qty: 3,
          sourceOrderId: "o1",
          subtotal: 30,
          taxAmount: 3,
          categoryTax: 0,
          return: { id: "r1", kind: "INLINE", status: "RECEIVED" },
        },
        {
          productId: "pA",
          qty: 5,
          sourceOrderId: "o1",
          subtotal: 50,
          taxAmount: 5,
          categoryTax: 0,
          return: { id: "r2", kind: "INLINE", status: "CANCELLED" },
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 7, value: 77 });
  });

  it("a credit note that is a counted Return's own is counted once, through the Return, never again as standalone", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)])],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "REFUNDED",
          items: [{ productId: "pA", qty: 4 }],
        },
      ],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cnR",
          qty: 4,
          amount: 40,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
      linkedReturns: [{ id: "r1", creditNoteId: "cnR", status: "REFUNDED" }],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 6, value: 60 });
  });

  it("a credit note of a DEAD return is still money out: it counts as standalone (fail closed)", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)])],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "CANCELLED",
          items: [{ productId: "pA", qty: 4 }],
        },
      ],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cnR",
          qty: 4,
          amount: 40,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
      linkedReturns: [{ id: "r1", creditNoteId: "cnR", status: "CANCELLED" }],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 6, value: 60 });
  });

  it("(c) an amount-only invoice credit note of $15 on a $50 invoice caps the invoice at $35 and no pool", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 50, [line("l1", "pA", 5, 30), line("l2", "pB", 2, 20)])],
      amountOnly: [{ id: "cnA", invoiceId: "i1", amount: 15, status: "ISSUED" }],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(rem.byInvoice.get("i1")?.value).toBe(35);
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 5, value: 30 });
    expect(poolOf(rem, "i1", "pB")).toMatchObject({ qty: 2, value: 20 });
    // refunds across both products fit their pools ($30 + $20) but not the invoice's $35
    expect(
      refundableRefusal(rem, [
        { invoiceId: "i1", productId: "pA", qty: 5, value: 30 },
        { invoiceId: "i1", productId: "pB", qty: 2, value: 20 },
      ]),
    ).toEqual({ invoiceId: "i1", remainingQty: null, remainingValue: 35 });
    expect(
      refundableRefusal(rem, [
        { invoiceId: "i1", productId: "pA", qty: 5, value: 20 },
        { invoiceId: "i1", productId: "pB", qty: 1, value: 15 },
      ]),
    ).toBeNull();
  });

  it("(c) a VOID amount-only credit note, and one that is a Return's own, are not netted at the invoice", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 50, [line("l1", "pA", 5, 50)])],
      amountOnly: [
        { id: "cnV", invoiceId: "i1", amount: 15, status: "VOID" },
        { id: "cnR", invoiceId: "i1", amount: 10, status: "ISSUED" },
      ],
      linkedReturns: [{ id: "r1", creditNoteId: "cnR", status: "REFUNDED" }],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "REFUNDED",
          items: [{ productId: "pA", qty: 1 }],
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    // only the Return (1 piece of 5 at $10) is netted
    expect(rem.byInvoice.get("i1")?.value).toBe(40);
  });

  it("pooled invoices: one pool per product across the order's invoices, shared by both keys, counted once", async () => {
    const tx = fakeTx({
      invoices: [
        invoice("i1", "o1", 40, [line("l1", "pA", 4, 40)]),
        invoice("i2", "o1", 60, [line("l2", "pA", 6, 60)]),
      ],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "RECEIVED",
          items: [{ productId: "pA", qty: 3 }],
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    const a = poolOf(rem, "i1", "pA");
    expect(a).toBe(poolOf(rem, "i2", "pA"));
    expect(a).toMatchObject({ qty: 7, value: 70 });
    expect(rem.byInvoice.get("i1")).toBe(rem.byInvoice.get("i2"));
    expect(rem.byInvoice.get("i1")?.value).toBe(70);
  });

  it("a pool credited past its value (an old double pay) reads <= 0 and refuses any further request", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 20, [line("l1", "pA", 4, 20)])],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cn1",
          qty: 4,
          amount: 20,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "REFUNDED",
          items: [{ productId: "pA", qty: 4 }],
        },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    const pool = poolOf(rem, "i1", "pA");
    expect(pool?.qty).toBe(-4);
    expect(pool?.value).toBe(-20);
    expect(
      refundableRefusal(rem, [{ invoiceId: "i1", productId: "pA", qty: 1, value: 5 }]),
    ).toEqual({
      invoiceId: "i1",
      productId: "pA",
      remainingQty: 0,
      remainingValue: 0,
    });
  });

  it("excludeReturnId leaves the return being refunded out; excludeCreditNoteId leaves the credit note being edited out", async () => {
    const fixture: Fixture = {
      invoices: [invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)])],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "RECEIVED",
          items: [{ productId: "pA", qty: 4 }],
        },
      ],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cn1",
          qty: 2,
          amount: 20,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
    };
    expect(
      poolOf(await refundableRemainder(fakeTx(fixture), { invoiceIds: ["i1"] }), "i1", "pA"),
    ).toMatchObject({ qty: 4, value: 40 });
    expect(
      poolOf(
        await refundableRemainder(fakeTx(fixture), { invoiceIds: ["i1"], excludeReturnId: "r1" }),
        "i1",
        "pA",
      ),
    ).toMatchObject({ qty: 8, value: 80 });
    expect(
      poolOf(
        await refundableRemainder(fakeTx(fixture), {
          invoiceIds: ["i1"],
          excludeCreditNoteId: "cn1",
        }),
        "i1",
        "pA",
      ),
    ).toMatchObject({ qty: 6, value: 60 });
  });

  it("a credit note of the EXCLUDED return is not counted as standalone either (it is the one being replaced)", async () => {
    const tx = fakeTx({
      invoices: [invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)])],
      standardReturns: [
        {
          id: "r1",
          orderId: "o1",
          kind: "STANDARD",
          status: "REFUNDED",
          items: [{ productId: "pA", qty: 4 }],
        },
      ],
      cnItems: [
        {
          invoiceItemId: "l1",
          creditNoteId: "cnR",
          qty: 4,
          amount: 40,
          categoryTax: 0,
          creditNote: { status: "ISSUED" },
        },
      ],
      linkedReturns: [{ id: "r1", creditNoteId: "cnR", status: "REFUNDED" }],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"], excludeReturnId: "r1" });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 10, value: 100 });
  });

  it("a credit note line on a VOID or written-off invoice is not in any pool", async () => {
    const tx = fakeTx({
      invoices: [
        invoice("i1", "o1", 100, [line("l1", "pA", 10, 100)]),
        { ...invoice("i2", "o1", 100, [line("l2", "pA", 10, 100)]), status: "VOID" },
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1", "i2"] });
    expect(poolOf(rem, "i1", "pA")).toMatchObject({ qty: 10, value: 100 });
    expect(poolOf(rem, "i2", "pA")).toBeUndefined();
  });

  it("the invoice-level figure is the product lines' gross: a header discount or a fee line does not move it", async () => {
    const tx = fakeTx({
      invoices: [
        invoice("i1", "o1", 90, [
          line("l1", "pA", 10, 100),
          { ...line("l2", "pNull", 1, 25), productId: null },
        ]),
      ],
    });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(rem.byInvoice.get("i1")?.value).toBe(100);
  });

  it("an invoice that bills no goods (no product line) caps nothing", async () => {
    const tx = fakeTx({ invoices: [invoice("i1", "o1", 40, [])] });
    const rem = await refundableRemainder(tx, { invoiceIds: ["i1"] });
    expect(rem.byInvoice.size).toBe(0);
    expect(refundableRefusal(rem, [{ invoiceId: "i1", value: 999 }])).toBeNull();
  });

  it("creditableGroupInvoiceIds adds the order's other creditable invoices to the ones given, id-sorted", async () => {
    const tx = fakeTx({ invoices: [] });
    tx.invoice.findMany.mockResolvedValueOnce([{ id: "i3" }, { id: "i1" }]);
    expect(await creditableGroupInvoiceIds(tx, ["i2"])).toEqual(["i1", "i2", "i3"]);
    expect(await creditableGroupInvoiceIds(tx, [])).toEqual([]);
  });
});

describe("refundableRefusal: the check on a request", () => {
  const rem = async () =>
    refundableRemainder(
      fakeTx({
        invoices: [invoice("i1", "o1", 50, [line("l1", "pA", 5, 30), line("l2", "pA", 3, 20)])],
      }),
      { invoiceIds: ["i1"] },
    );

  it("fits exactly and fits within a cent; one piece or two cents over is refused with what is left", async () => {
    const r = await rem();
    expect(
      refundableRefusal(r, [{ invoiceId: "i1", productId: "pA", qty: 8, value: 50 }]),
    ).toBeNull();
    expect(
      refundableRefusal(r, [{ invoiceId: "i1", productId: "pA", qty: 8, value: 50.01 }]),
    ).toBeNull();
    expect(refundableRefusal(r, [{ invoiceId: "i1", productId: "pA", qty: 9, value: 50 }])).toEqual(
      {
        invoiceId: "i1",
        productId: "pA",
        remainingQty: 8,
        remainingValue: 50,
      },
    );
    expect(
      refundableRefusal(r, [{ invoiceId: "i1", productId: "pA", qty: 8, value: 50.03 }])
        ?.remainingValue,
    ).toBe(50);
  });

  it("two requests on one pool are added before they are compared", async () => {
    const r = await rem();
    expect(
      refundableRefusal(r, [
        { invoiceId: "i1", productId: "pA", qty: 5, value: 30 },
        { invoiceId: "i1", productId: "pA", qty: 4, value: 20 },
      ]),
    ).not.toBeNull();
  });

  it("a request for a product with no pool, or with no qty and no value, is not refused here", async () => {
    const r = await rem();
    expect(refundableRefusal(r, [{ invoiceId: "i1", productId: "pZ", qty: 99 }])).toBeNull();
    expect(refundableRefusal(r, [{ invoiceId: "i1", productId: "pA" }])).toBeNull();
    expect(refundableRefusal(r, [])).toBeNull();
  });
});
