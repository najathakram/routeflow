import { Sa839LedgerWorld } from "./testing/sa839-ledger-world";

/**
 * SA-819 call 1 (b): a repeat `INVOICE_BILLED` with the SAME lines writes 0 rows, with and without a live return
 * standing on the line, and after a real change. Unit lane over the SA-839 fake world (the real ledger service).
 */
describe("settleRegulatedLedger INVOICE_BILLED is idempotent (changed-only re-sync)", () => {
  let w: Sa839LedgerWorld;
  beforeEach(() => {
    w = new Sa839LedgerWorld();
  });
  const line = (over: Record<string, unknown> = {}) => ({
    invoiceItemId: "ii-1",
    orderItemId: "oi-1",
    trackedCategoryId: "cat-A",
    qty: 10,
    netSales: 100,
    categoryTax: 20,
    ...over,
  });
  const billed = (lines = [line()]) =>
    w.service.settleRegulatedLedger(w.prisma as any, {
      kind: "INVOICE_BILLED",
      invoiceId: "inv-1",
      orderId: "ord-1",
      tenantId: "test-tenant",
      lines: lines as any,
    });

  it("an unchanged invoice writes 0 rows, twice", async () => {
    w.seedSale();
    const before = w.ledger.length;
    expect((await billed()).written).toBe(0);
    expect((await billed()).written).toBe(0);
    expect(w.ledger).toHaveLength(before);
  });

  it("an unchanged invoice with a live received return writes 0 rows, twice, and the return stands", async () => {
    w.seedSale();
    w.addReturn("r1");
    w.seedReturnRow("r1");
    const before = w.ledger.length;
    expect((await billed()).written).toBe(0);
    expect((await billed()).written).toBe(0);
    expect(w.ledger).toHaveLength(before);
    expect(w.sum()).toEqual({ qty: 7, unitBasisQty: 7, net: 70, tax: 14 });
  });

  it("a real change writes one REVERSAL + SALE pair, and repeating it writes 0", async () => {
    w.seedSale();
    w.addReturn("r1");
    w.seedReturnRow("r1");
    const changed = [line({ qty: 8, netSales: 80, categoryTax: 16 })];
    expect((await billed(changed)).written).toBe(2);
    const after = w.ledger.length;
    expect((await billed(changed)).written).toBe(0);
    expect(w.ledger).toHaveLength(after);
    expect(w.sum()).toEqual({ qty: 5, unitBasisQty: 5, net: 50, tax: 10 }); // 8 delivered - 3 returned
  });
});
