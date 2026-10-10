/**
 * SA-760 Q-760-1 (OWNER answer 10-10), red rows: when a staff order edit changes the PRICE of a line that a
 * partial invoice bills,
 *   - a DRAFT partial FOLLOWS: unit price, the line's money and the tax snapshot are rebuilt through the
 *     invoice-line builder with roundMoney, the invoice total is recomputed;
 *   - an ISSUED partial never changes and is listed (`issuedPartialsUnchanged`);
 *   - price only: quantities never change, and the partial never gains the order's un-billed lines.
 * The partials are cut by the REAL writer (createPartialFromOrder) over the stateful fake.
 */

jest.mock("./invoice-pdf.service", () => ({
  InvoicePdfService: jest.fn().mockImplementation(() => ({
    getOrGenerate: jest.fn().mockResolvedValue("https://example.com/invoice.pdf"),
  })),
}));
jest.mock("../storage/compress.util", () => ({
  compressDocument: jest.fn(),
}));

import { InvoicesService } from "./invoices.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { SplitInvoiceFakeDb, fakeOrderLine } from "./testing/split-invoice-fake-db";
import { buildSplitInvoicesService } from "./testing/split-invoice-service";

describe("SA-760 Q-760-1: a DRAFT partial follows order price edits (price only); issued partials never change", () => {
  let service: InvoicesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: SplitInvoiceFakeDb;
  const mockLedger = { writeSaleEntries: jest.fn(), reverseInvoiceEntries: jest.fn() };

  beforeEach(async () => {
    prisma = createMockPrisma();
    db = new SplitInvoiceFakeDb();
    db.install(prisma);
    service = await buildSplitInvoicesService(InvoicesService, prisma, mockLedger);
    // two lines: A (10 boxes x 12 @ 2.35 = 282.00) and B (5 boxes x 12 @ 1.00 = 60.00); nothing taxed
    db.addOrder(
      {
        id: "ord-1",
        customerId: "cust-1",
        orderNumber: "ORD-1",
        subtotal: 342,
        tax: 0,
        shippingFee: 0,
        total: 342,
      },
      [
        fakeOrderLine({
          id: "oi-A",
          productId: "p-A",
          qty: 120,
          boxes: 10,
          unitPrice: 2.35,
          subtotal: 282,
        }),
        fakeOrderLine({
          id: "oi-B",
          productId: "p-B",
          qty: 60,
          boxes: 5,
          unitPrice: 1,
          subtotal: 60,
        }),
      ],
    );
  });

  const partialA = (qty = 72) =>
    service.createPartialFromOrder("ord-1", { items: [{ orderItemId: "oi-A", qty }] } as any);
  /** The order edit: line A's unit price 2.35 -> 2.50 (qty unchanged), the order totals restated. */
  const repriceA = () => {
    Object.assign(db.line("oi-A"), { unitPrice: 2.5, subtotal: 300 });
    Object.assign(db.orders.get("ord-1")!, { subtotal: 360, total: 360 });
  };

  it("a DRAFT partial of line A is re-priced; its qty is unchanged and it never gains line B", async () => {
    const created = await partialA(72);
    expect(Number(created.total)).toBe(169.2); // 72/120 of 282
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    const inv = db.invoicesOf("ord-1")[0];
    expect(inv.items).toHaveLength(1); // price only: no line gained
    expect(inv.items[0]).toMatchObject({ orderItemId: "oi-A" });
    expect(Number(inv.items[0].qty)).toBe(72); // the partition stands
    expect(Number(inv.items[0].unitPrice)).toBe(2.5);
    expect(Number(inv.items[0].subtotal)).toBe(180); // 72/120 of the new 300
    expect(Number(inv.subtotal)).toBe(180);
    expect(Number(inv.total)).toBe(180); // master today: still 169.20
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.line("oi-A").invoicedQty).toBe(72); // the counter is untouched by a price follow
    expect(db.line("oi-B").invoicedQty).toBe(0);
  });

  it("an ISSUED partial is unchanged and listed in issuedPartialsUnchanged", async () => {
    const created = await partialA(72);
    db.invoices.find((i) => i.id === created.id)!.status = "SENT";
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    expect(out.issuedPartialsUnchanged).toEqual([
      { invoiceId: created.id, invoiceNumber: created.invoiceNumber },
    ]);
    const inv = db.invoicesOf("ord-1")[0];
    expect(Number(inv.items[0].unitPrice)).toBe(2.35);
    expect(Number(inv.total)).toBe(169.2);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("two partials of one line: the DRAFT follows, the issued one stays, and Σ the line is consistent", async () => {
    const first = await partialA(72);
    await partialA(48);
    db.invoices.find((i) => i.id === first.id)!.status = "SENT";
    repriceA();

    const out = await service.followPartialPrices("ord-1");

    expect(out.issuedPartialsUnchanged.map((x) => x.invoiceId)).toEqual([first.id]);
    const [issued, draft] = db.invoicesOf("ord-1");
    expect(Number(issued.total)).toBe(169.2);
    // telescoped over what the line already billed: round(300 * 120/120) - round(300 * 72/120) = 120
    expect(Number(draft.items[0].subtotal)).toBe(120);
    expect(Number(draft.items[0].qty)).toBe(48);
    expect(Number(draft.total)).toBe(120);
  });

  it("a qty-only edit (price unchanged) changes nothing", async () => {
    await partialA(72);
    Object.assign(db.line("oi-A"), { qty: 132, boxes: 11, subtotal: 258.5 }); // 11 boxes at the same 2.35
    const out = await service.followPartialPrices("ord-1");
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("the sole invoice that bills the whole order is the MIRROR, not a partial: left to the re-sync", async () => {
    await service.createInvoiceFromOrder("ord-1");
    expect(db.invoicesOf("ord-1")).toHaveLength(1);
    Object.assign(db.line("oi-A"), { unitPrice: 2.5, subtotal: 300 });
    const out = await service.followPartialPrices("ord-1");
    expect(out.issuedPartialsUnchanged).toEqual([]);
    expect(db.invoiceUpdateCalls).toHaveLength(0);
  });

  it("projectEditedInvoiceTotals({partials}) reports exactly the total the follow then writes", async () => {
    await partialA(72);
    repriceA();
    const projected = await service.projectEditedInvoiceTotals(
      { ...(prisma as any).forTenant(), $executeRaw: jest.fn() },
      "ord-1",
      { resync: false, partials: true },
    );
    expect(projected).toEqual([{ invoiceId: db.invoicesOf("ord-1")[0].id, projectedTotal: 180 }]);
    expect(db.invoiceUpdateCalls).toHaveLength(0); // projecting writes nothing
    await service.followPartialPrices("ord-1");
    expect(Number(db.invoicesOf("ord-1")[0].total)).toBe(projected[0].projectedTotal);
  });
});
