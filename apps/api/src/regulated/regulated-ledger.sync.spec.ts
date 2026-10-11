import { RegulatedLedgerService, netHeldByLine } from "./regulated-ledger.service";

/**
 * B297 PR4 (SA-734r2 B5 / D5): `syncInvoiceEntries` writes ONLY what changed, on the SAME net-held
 * arithmetic `reverseInvoiceEntries` uses. Pure mock-db pins; the real-Postgres chain is
 * invoices/ledger-resync-noop-b297.db.spec.ts.
 */
const sale = (over: Record<string, unknown> = {}) => ({
  id: "r-sale",
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
  ...over,
});
const line = (over: Record<string, unknown> = {}) => ({
  invoiceItemId: "ii-1",
  orderItemId: "oi-1",
  trackedCategoryId: "cat-1",
  qty: 12,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  unitLabel: null,
  packAtSale: null,
  netSales: 120,
  categoryTax: 0.6,
  ...over,
});

function setup(rows: any[]) {
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const db = {
    regulatedSalesLedger: { findMany: jest.fn().mockResolvedValue(rows), createMany },
  };
  const svc = new RegulatedLedgerService({} as any);
  const sync = (lines: any[]) =>
    svc.syncInvoiceEntries({
      invoiceId: "inv-1",
      orderId: "o1",
      tenantId: "t1",
      soldAt: new Date("2026-10-11T00:00:00Z"),
      lines,
      db,
    });
  const written = () => createMany.mock.calls.flatMap((c) => c[0].data as any[]);
  return { sync, written, createMany };
}

describe("RegulatedLedgerService.syncInvoiceEntries (B297 PR4)", () => {
  it("an unchanged line writes NOTHING", async () => {
    const { sync, createMany } = setup([sale()]);
    await sync([line()]);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a changed line gets exactly one REVERSAL of the held net and one SALE of the target", async () => {
    const { sync, written } = setup([sale()]);
    await sync([line({ qty: 10, netSales: 100, categoryTax: 0.5 })]);
    const rows = written();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      entryType: "REVERSAL",
      invoiceItemId: "ii-1",
      qty: -12,
      netSales: -120,
      categoryTax: -0.6,
    });
    expect(rows[1]).toMatchObject({
      entryType: "SALE",
      invoiceItemId: "ii-1",
      qty: 10,
      netSales: 100,
      categoryTax: 0.5,
    });
  });

  it("only the changed line is touched when two lines are held", async () => {
    const { sync, written } = setup([
      sale(),
      sale({
        id: "r-b",
        invoiceItemId: "ii-2",
        orderItemId: "oi-2",
        qty: 6,
        netSales: 60,
        categoryTax: 0.3,
        unitBasisQty: 6,
      }),
    ]);
    await sync([
      line(),
      line({ invoiceItemId: "ii-2", orderItemId: "oi-2", qty: 6, netSales: 60, categoryTax: 0.3 }),
      // ii-1 unchanged, ii-2 unchanged
    ]);
    expect(written()).toHaveLength(0);
    const second = setup([
      sale(),
      sale({
        id: "r-b",
        invoiceItemId: "ii-2",
        orderItemId: "oi-2",
        qty: 6,
        netSales: 60,
        categoryTax: 0.3,
        unitBasisQty: 6,
      }),
    ]);
    await second.sync([
      line(),
      line({ invoiceItemId: "ii-2", orderItemId: "oi-2", qty: 5, netSales: 50, categoryTax: 0.25 }),
    ]);
    expect(second.written().map((r) => [r.invoiceItemId, r.entryType])).toEqual([
      ["ii-2", "REVERSAL"],
      ["ii-2", "SALE"],
    ]);
  });

  it("a held line that is no longer a regulated target is reversed (and nothing is booked for it)", async () => {
    const { sync, written } = setup([sale()]);
    await sync([line({ trackedCategoryId: null })]);
    expect(written().map((r) => r.entryType)).toEqual(["REVERSAL"]);
  });

  it("a replaced invoice item id: the old id is reversed, the new id is booked", async () => {
    const { sync, written } = setup([sale()]);
    await sync([line({ invoiceItemId: "ii-NEW" })]);
    expect(written().map((r) => [r.invoiceItemId, r.entryType])).toEqual([
      ["ii-1", "REVERSAL"],
      ["ii-NEW", "SALE"],
    ]);
  });

  it("H1: the same money re-filed to another CATEGORY books a reversal under the old one and a SALE under the new", async () => {
    const { sync, written } = setup([sale()]);
    await sync([line({ trackedCategoryId: "cat-2" })]);
    expect(written().map((r) => [r.entryType, r.trackedCategoryId, r.qty])).toEqual([
      ["REVERSAL", "cat-1", -12],
      ["SALE", "cat-2", 12],
    ]);
  });

  it("H1: a changed reporting SUBCATEGORY is a change of the booked line", async () => {
    const { sync, written } = setup([sale({ trackedSubcategoryId: "sub-a" })]);
    await sync([line({ trackedSubcategoryId: "sub-b" })]);
    expect(written().map((r) => [r.entryType, r.trackedSubcategoryId])).toEqual([
      ["REVERSAL", "sub-a"],
      ["SALE", "sub-b"],
    ]);
  });

  it("H1: an order-line RELINK (the return cap's key) is a change of the booked line", async () => {
    const { sync, written } = setup([sale()]);
    await sync([line({ orderItemId: "oi-9" })]);
    expect(written().map((r) => [r.entryType, r.orderItemId])).toEqual([
      ["REVERSAL", "oi-1"],
      ["SALE", "oi-9"],
    ]);
  });

  it("a PIECE-basis change with the same qty and money is a change (the box-unaware pack moved)", async () => {
    const { sync, written } = setup([sale({ unitBasisQty: 12 })]);
    await sync([line({ packAtSale: 24 })]); // qty 12 x pack 24 = 288 pieces, held 12
    expect(written().map((r) => r.entryType)).toEqual(["REVERSAL", "SALE"]);
  });

  it("a credit-note reversal stays standing like a return's", async () => {
    const { sync, createMany } = setup([
      sale(),
      sale({
        id: "r-cn",
        entryType: "REVERSAL",
        creditNoteId: "cn-1",
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -0.1,
      }),
    ]);
    await sync([line()]);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("M1: after SALE(cat-1), its REVERSAL and SALE(cat-2) the next change reverses the CATEGORY the net sits in", async () => {
    const { sync, written } = setup([
      sale({ id: "x", trackedCategoryId: "cat-1" }),
      sale({
        id: "x-rev",
        entryType: "REVERSAL",
        trackedCategoryId: "cat-1",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
      }),
      sale({ id: "y", trackedCategoryId: "cat-2" }),
    ]);
    await sync([line({ trackedCategoryId: "cat-2", qty: 10, netSales: 100, categoryTax: 0.5 })]);
    expect(written().map((r) => [r.entryType, r.trackedCategoryId, r.qty])).toEqual([
      ["REVERSAL", "cat-2", -12],
      ["SALE", "cat-2", 10],
    ]);
  });

  it("a prior return's reversal stays standing: the held net excludes it, so an unchanged line writes nothing", async () => {
    const { sync, createMany } = setup([
      sale(),
      sale({
        id: "r-ret",
        entryType: "REVERSAL",
        returnId: "ret-1",
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -0.1,
      }),
    ]);
    await sync([line()]);
    expect(createMany).not.toHaveBeenCalled();
  });

  it("a changed line reverses only the sale-record net, never the return's reduction", async () => {
    const { sync, written } = setup([
      sale(),
      sale({
        id: "r-ret",
        entryType: "REVERSAL",
        returnId: "ret-1",
        qty: -2,
        unitBasisQty: -2,
        netSales: -20,
        categoryTax: -0.1,
      }),
    ]);
    await sync([line({ qty: 10, netSales: 100, categoryTax: 0.5 })]);
    expect(written()[0]).toMatchObject({ entryType: "REVERSAL", qty: -12, netSales: -120 });
  });

  it("is idempotent: the rows a sync wrote make the same sync a no-op", async () => {
    const first = setup([sale()]);
    await first.sync([line({ qty: 10, netSales: 100, categoryTax: 0.5 })]);
    const rows = [
      sale(),
      ...first.written().map((r, i) => ({ ...r, id: `n${i}`, returnId: null, creditNoteId: null })),
    ];
    const second = setup(rows);
    await second.sync([line({ qty: 10, netSales: 100, categoryTax: 0.5 })]);
    expect(second.written()).toHaveLength(0);
  });

  it("a fully reversed line that is still a target is simply booked again", async () => {
    const { sync, written } = setup([
      sale(),
      sale({
        id: "r-rev",
        entryType: "REVERSAL",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
      }),
    ]);
    await sync([line()]);
    expect(written().map((r) => r.entryType)).toEqual(["SALE"]);
  });

  it("writes nothing without a tenant", async () => {
    const createMany = jest.fn();
    const db = {
      regulatedSalesLedger: { findMany: jest.fn().mockResolvedValue([sale()]), createMany },
    };
    await new RegulatedLedgerService({} as any).syncInvoiceEntries({
      invoiceId: "inv-1",
      orderId: null,
      tenantId: null,
      soldAt: new Date(),
      lines: [line({ qty: 1 })],
      db,
    });
    expect(createMany).not.toHaveBeenCalled();
  });
});

describe("RegulatedLedgerService.reverseInvoiceEntries nets per category (B297 PR4 M1)", () => {
  it("a void reverses the net under the category it sits in, not the first SALE read", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const rows = [
      sale({ id: "x", trackedCategoryId: "cat-1" }),
      sale({
        id: "x-rev",
        entryType: "REVERSAL",
        trackedCategoryId: "cat-1",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
      }),
      sale({ id: "y", trackedCategoryId: "cat-2" }),
    ];
    const db = {
      regulatedSalesLedger: { findMany: jest.fn().mockResolvedValue(rows), createMany },
    };
    await new RegulatedLedgerService({} as any).reverseInvoiceEntries({ invoiceId: "inv-1", db });
    const written = createMany.mock.calls.flatMap((c) => c[0].data as any[]);
    expect(written.map((r) => [r.entryType, r.trackedCategoryId, r.qty])).toEqual([
      ["REVERSAL", "cat-2", -12],
    ]);
  });
});

describe("void metadata after a re-file (B297 PR4 review MED-1)", () => {
  it("a void after a SUBCATEGORY re-file reverses the net under the LIVE sale's subcategory", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    // SALE1 (sub-a), the sync's REVERSAL of it (sub-a), then SALE2 (sub-b): the net sits under sub-b
    const rows = [
      sale({
        id: "s1",
        trackedSubcategoryId: "sub-a",
        createdAt: new Date("2026-10-01T00:00:00Z"),
      }),
      sale({
        id: "s1-rev",
        entryType: "REVERSAL",
        trackedSubcategoryId: "sub-a",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      }),
      sale({
        id: "s2",
        trackedSubcategoryId: "sub-b",
        createdAt: new Date("2026-10-02T00:00:01Z"),
      }),
    ];
    // an unordered read must not matter: the dead SALE is returned FIRST, before the live one
    const db = {
      regulatedSalesLedger: {
        findMany: jest.fn().mockResolvedValue([rows[0], rows[1], rows[2]]),
        createMany,
      },
    };
    await new RegulatedLedgerService({} as any).reverseInvoiceEntries({ invoiceId: "inv-1", db });
    const written = createMany.mock.calls.flatMap((c) => c[0].data as any[]);
    expect(written.map((r) => [r.entryType, r.trackedSubcategoryId, r.qty])).toEqual([
      ["REVERSAL", "sub-b", -12],
    ]);
  });

  it("a void after an order-line RELINK reverses against the live order line", async () => {
    const createMany = jest.fn().mockResolvedValue({ count: 0 });
    const rows = [
      sale({ id: "s1", orderItemId: "oi-1", createdAt: new Date("2026-10-01T00:00:00Z") }),
      sale({
        id: "s1-rev",
        entryType: "REVERSAL",
        orderItemId: "oi-1",
        qty: -12,
        unitBasisQty: -12,
        netSales: -120,
        categoryTax: -0.6,
        createdAt: new Date("2026-10-02T00:00:00Z"),
      }),
      sale({ id: "s2", orderItemId: "oi-9", createdAt: new Date("2026-10-02T00:00:01Z") }),
    ];
    const db = {
      regulatedSalesLedger: {
        findMany: jest.fn().mockResolvedValue([rows[0], rows[1], rows[2]]),
        createMany,
      },
    };
    await new RegulatedLedgerService({} as any).reverseInvoiceEntries({ invoiceId: "inv-1", db });
    const written = createMany.mock.calls.flatMap((c) => c[0].data as any[]);
    expect(written.map((r) => [r.entryType, r.orderItemId, r.qty])).toEqual([
      ["REVERSAL", "oi-9", -12],
    ]);
  });
});

describe("netHeldByLine (the one netting implementation)", () => {
  it("sums every signed row per invoice line, and leaves return / credit reversals out under preserveReturns", () => {
    const rows = [
      sale(),
      sale({
        id: "a",
        entryType: "REVERSAL",
        qty: -3,
        unitBasisQty: -3,
        netSales: -30,
        categoryTax: -0.15,
        returnId: "r1",
      }),
      sale({
        id: "b",
        entryType: "REVERSAL",
        qty: -1,
        unitBasisQty: -1,
        netSales: -10,
        categoryTax: -0.05,
        creditNoteId: "c1",
      }),
    ];
    const all = netHeldByLine(rows).get("ii-1|cat-1")!;
    expect([all.qty, all.netSales]).toEqual([8, 80]);
    const kept = netHeldByLine(rows, { preserveReturns: true }).get("ii-1|cat-1")!;
    expect([kept.qty, kept.netSales]).toEqual([12, 120]);
    expect(kept.sale).toBe(rows[0]);
  });
});
