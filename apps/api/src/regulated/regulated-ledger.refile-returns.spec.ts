import { RegulatedLedgerService } from "./regulated-ledger.service";

/**
 * B297 row 341: after a line is re-filed to another category (a draft edit's product swap), a RETURN or a
 * CREDIT NOTE must book its reversal under the line's LIVE booked key (category / subcategory / order line),
 * not under the dead, already reversed SALE that is read first. The per-order-line remaining is unchanged.
 */
const row = (over: Record<string, unknown> = {}) => ({
  id: "r",
  tenantId: "t1",
  trackedCategoryId: "cat-1",
  trackedSubcategoryId: null,
  entryType: "SALE",
  orderId: "o1",
  orderItemId: "oi-1",
  invoiceId: "inv-1",
  invoiceItemId: "ii-1",
  qty: 12,
  unitBasisQty: 12,
  netSales: 120,
  categoryTax: 0.6,
  returnId: null,
  creditNoteId: null,
  correctsEntryId: null,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

/** A just-enough `findMany` over an in-memory row list (equality, {in}, {not}, OR, nested entryType {in}). */
function matches(r: any, where: any): boolean {
  return Object.entries(where ?? {}).every(([k, v]: [string, any]) => {
    if (k === "OR") return (v as any[]).some((w) => matches(r, w));
    if (v && typeof v === "object" && "in" in v) return (v.in as any[]).includes(r[k]);
    if (v && typeof v === "object" && "not" in v) return r[k] !== v.not;
    return r[k] === v;
  });
}
function dbOver(rows: any[], extra: Record<string, any> = {}) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const db = {
    regulatedSalesLedger: {
      findMany: jest.fn(async (a: any) => rows.filter((r) => matches(r, a?.where))),
      createMany,
    },
    invoiceItem: { findMany: jest.fn().mockResolvedValue([{ id: "ii-1", productId: "p1" }]) },
    creditNoteItem: { findMany: jest.fn().mockResolvedValue([]) },
    ...extra,
  };
  return { db, written: () => createMany.mock.calls.flatMap((c) => c[0].data as any[]) };
}

// The line was SOLD under cat-1 / sub-a, re-filed to cat-2 / sub-b at the same money.
const REFILED = [
  row({ id: "s1", createdAt: new Date("2026-10-01T00:00:00Z"), trackedSubcategoryId: "sub-a" }),
  row({
    id: "s1-rev",
    entryType: "REVERSAL",
    createdAt: new Date("2026-10-02T00:00:00Z"),
    trackedSubcategoryId: "sub-a",
    qty: -12,
    unitBasisQty: -12,
    netSales: -120,
    categoryTax: -0.6,
  }),
  row({
    id: "s2",
    createdAt: new Date("2026-10-02T00:00:01Z"),
    trackedCategoryId: "cat-2",
    trackedSubcategoryId: "sub-b",
  }),
];

describe("a return after a re-file (B297 row 341)", () => {
  const ret = (db: any) =>
    new RegulatedLedgerService({} as any).reverseReturnEntries({
      returnId: "ret-1",
      orderId: "o1",
      returnedByProduct: new Map([["p1", 4]]),
      returnedUnit: "LINE_UNIT",
      db,
    });

  it("books the reversal under the LIVE category and subcategory, never the dead sale's", async () => {
    const { db, written } = dbOver(REFILED);
    await ret(db);
    expect(
      written().map((r) => [r.entryType, r.trackedCategoryId, r.trackedSubcategoryId, r.qty]),
    ).toEqual([["REVERSAL", "cat-2", "sub-b", -4]]);
  });

  it("an un-refiled line is unchanged: the (only) sale is the target", async () => {
    const { db, written } = dbOver([row()]);
    await ret(db);
    expect(written().map((r) => [r.trackedCategoryId, r.qty])).toEqual([["cat-1", -4]]);
  });
});

describe("a credit note after a re-file (B297 row 341)", () => {
  it("carries the live key's subcategory, order line and invoice, not the first SALE read", async () => {
    const rows = [
      // the dead sale carries a different order line / subcategory than the live one
      row({
        id: "s1",
        orderItemId: "oi-OLD",
        invoiceId: "inv-OLD",
        trackedSubcategoryId: "sub-a",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      }),
      row({
        id: "s1-rev",
        entryType: "REVERSAL",
        orderItemId: "oi-OLD",
        invoiceId: "inv-OLD",
        trackedSubcategoryId: "sub-a",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      }),
      row({
        id: "s2",
        trackedCategoryId: "cat-2",
        trackedSubcategoryId: "sub-b",
        orderItemId: "oi-1",
        createdAt: new Date("2026-10-02T00:00:01Z"),
      }),
    ];
    const { db, written } = dbOver(rows);
    db.creditNoteItem.findMany.mockResolvedValue([
      {
        tenantId: "t1",
        invoiceItemId: "ii-1",
        trackedCategoryId: "cat-2",
        amount: 40,
        qty: 4,
        categoryTax: 0.2,
      },
    ]);
    await new RegulatedLedgerService({} as any).reverseCreditNoteEntries({
      creditNoteId: "cn-1",
      db,
    });
    const w = written();
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({
      entryType: "REVERSAL",
      trackedCategoryId: "cat-2",
      trackedSubcategoryId: "sub-b",
      orderItemId: "oi-1",
      invoiceId: "inv-1",
      creditNoteId: "cn-1",
    });
  });
});
