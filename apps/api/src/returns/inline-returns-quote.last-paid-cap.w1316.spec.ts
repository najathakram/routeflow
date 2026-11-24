/**
 * W-1316 PR-1 (a sold item's return credit never tops its last paid price): a chunk of a product the customer WAS sold, but
 * outside the matching window (or past what the window holds), credits the lower of today's price and the figure the customer
 * last paid, taken from `refundableLineShare` (never `qty * unitPrice`). A matched chunk and a never-sold chunk are unchanged.
 * The real-Postgres proof is the D8 DB spec; this file pins the quote on a mock (a mock accepts any `where`, so the
 * newest-first `orderBy` is asserted on the call, the figures on the rows the mock returns).
 */
import { operatorWithRights } from "../common/testing/operator-with-rights";
import { Test } from "@nestjs/testing";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const OPERATOR = {
  sub: "user-op-1",
  role: "OPERATOR",
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

interface SoldLine {
  id: string;
  qty: number;
  subtotal: number;
  boxes?: number | null;
  unitsPerBox?: number | null;
}

/** The customer's newest live sale of the product, as the last-sale read returns it: the row the read landed on (`rowId`) and its
 * whole invoice, every line of the product on it. */
const soldOn = (lines: SoldLine[], rowId: string = lines[0].id) => {
  return {
    id: rowId,
    invoice: {
      taxAmount: 0,
      discount: 0,
      items: lines.map((l) => ({
        id: l.id,
        productId: "prod-1",
        boxes: l.boxes ?? null,
        unitsPerBox: l.unitsPerBox ?? null,
        systemKind: null,
        description: null,
        qty: l.qty,
        subtotal: l.subtotal,
        taxRate: 0,
        categoryTaxAmount: 0,
      })),
    },
  };
};
const lastSale = (o: { qty?: number; subtotal: number; unitsPerBox?: number | null }) =>
  soldOn([{ id: "item-old", qty: o.qty ?? 1, subtotal: o.subtotal, unitsPerBox: o.unitsPerBox }]);

const windowInvoice = (unitPrice: number) => ({
  orderId: "ord-1",
  subtotal: unitPrice,
  discount: 0,
  taxAmount: 0,
  items: [
    {
      id: "item-1",
      orderItemId: "oi-1",
      productId: "prod-1",
      qty: 1,
      unitPrice,
      subtotal: unitPrice,
      boxes: null,
      pieces: null,
      unitsPerBox: null,
      promoFreeUnits: null,
      taxRate: 0,
      categoryTaxAmount: 0,
    },
  ],
});

describe("W-1316 PR-1: an old sale's return credit is capped at its last paid price", () => {
  let service: InlineReturnsQuoteService;
  let db: any;

  const setup = async (product: Record<string, unknown> = {}) => {
    const prisma = createMockPrisma();
    operatorWithRights(prisma, OPERATOR);
    db = prisma.forTenant();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SystemConfigService,
          useValue: {
            get: jest.fn().mockResolvedValue("8"),
            getAll: jest.fn().mockResolvedValue({}),
          },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsQuoteService);
    db.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      isTaxExempt: false,
      isWalkIn: false,
    });
    db.customerPrice.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        name: "Widget",
        pricePerUnit: 12,
        priceTier2: 12,
        priceTier3: 12,
        priceTier4: 12,
        priceTier5: 12,
        unitsPerBox: null,
        ...product,
      },
    ]);
    db.return.findMany.mockResolvedValue([]);
    db.returnItem.findMany.mockResolvedValue([]);
    db.invoice.findMany.mockResolvedValue([]); // nothing in the 90-day window
  };

  const dto = (pieces: number, extra: Record<string, unknown> = {}) =>
    ({ customerId: "cust-1", items: [{ productId: "prod-1", boxes: 0, pieces, ...extra }] }) as any;
  const quote = (pieces: number, extra: Record<string, unknown> = {}) =>
    service.quote(dto(pieces, extra), OPERATOR);

  it("C1 (pin, green on master): a sale in the window credits what it charged", async () => {
    await setup();
    db.invoice.findMany.mockResolvedValue([windowInvoice(10)]);
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: "ord-1", subtotal: 10 });
  });

  it("C2: sold at $10 outside the window, today $12: the default credit is $10 from the invoice", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 10 }));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({
      subtotal: 10,
      unitPrice: 10,
      priceSource: "SOURCE_INVOICE",
    });
  });

  it("C3 (pin, green on master): sold at $14, today $12: today's price, today's source", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 14 }));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 12, unitPrice: 12, priceSource: "BASE" });
  });

  it("C4: the LAST paid wins, not the lowest: the read is newest invoice first and the $11 row prices", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 11 })); // the newest of $9 then $11
    const q = await quote(1);
    expect(db.invoiceItem.findFirst.mock.calls[0][0].orderBy).toEqual([
      { invoice: { issueDate: "desc" } },
      { invoice: { createdAt: "desc" } },
      { invoice: { id: "desc" } },
    ]);
    expect(q.chunks[0]).toMatchObject({ subtotal: 11, unitPrice: 11 });
  });

  it("C5: a boxed sale, 1 box of 24 at $48, one piece back, today $2.50 a piece: $2.00 a piece", async () => {
    await setup({
      pricePerUnit: 60,
      priceTier2: 60,
      priceTier3: 60,
      priceTier4: 60,
      priceTier5: 60,
      unitsPerBox: 24,
    });
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 48, unitsPerBox: 24 }));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({
      subtotal: 2,
      unitPrice: 48,
      priceSource: "SOURCE_INVOICE",
    });
  });

  it("C6: an edit to $11 on C2's line is over the cap: 400 naming $10.00", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 10 }));
    await expect(quote(1, { creditUnitPrice: 11, overrideReason: "Dented" })).rejects.toMatchObject(
      {
        response: {
          code: "RETURN_CREDIT_OVER_CAP",
          message: expect.stringContaining("the most this return can credit is $10.00"),
        },
      },
    );
  });

  it("C7 (pin, green on master): a never-sold item credits today's price, untaxed", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(null);
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 12, taxAmount: 0, neverSold: true });
  });

  it("C8: the capture's pricer returns the quoted credit for C2 ($10)", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 10 }));
    const q = await quote(1);
    const priced = await service.priceInlineReturn(dto(1), OPERATOR, db);
    expect(priced.total).toBe(q.total);
    expect(priced.chunks[0].subtotal).toBe(10);
  });

  // SA-1244 A1: a $0.00 last paid price CAPS the credit at $0.00; it is never read as "no paid price".
  it("E1: the last sale was 1 piece at $0.00 outside the window, today $12: the credit is $0.00, SOURCE_INVOICE", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 0 }));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({
      subtotal: 0,
      unitPrice: 0,
      taxAmount: 0,
      priceSource: "SOURCE_INVOICE",
    });
    expect(q.total).toBe(0);
  });

  it("E1-pin (green on master): the same $0.00 line inside the window credits $0.00", async () => {
    await setup();
    db.invoice.findMany.mockResolvedValue([windowInvoice(0)]);
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: "ord-1", subtotal: 0 });
  });

  // SA-1244 A2: the cap is the product's POOLED price on the newest invoice (SA-970), never one line picked by uuid.
  const PAID = { id: "u-paid", qty: 10, subtotal: 100 };
  const FREE = { id: "u-free", qty: 2, subtotal: 0 };
  const price = (n: number) => ({
    pricePerUnit: n,
    priceTier2: n,
    priceTier3: n,
    priceTier4: n,
    priceTier5: n,
  });

  it("G1: newest invoice 10 pcs paid at 100.00 + 2 free, today 12.00 a piece, 1 piece back: 8.33 from the invoice", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(soldOn([PAID, FREE], "u-paid"));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 8.33, priceSource: "SOURCE_INVOICE" });
  });

  it("G2: newest invoice two lines, 1 pc at 100.00 and 1 pc at 50.00, today 120.00, 1 piece back: 75.00", async () => {
    await setup(price(120));
    db.invoiceItem.findFirst.mockResolvedValue(
      soldOn([
        { id: "u-dear", qty: 1, subtotal: 100 },
        { id: "u-cheap", qty: 1, subtotal: 50 },
      ]),
    );
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 75, priceSource: "SOURCE_INVOICE" });
  });

  it("G3: the product's only lines on the newest invoice are all 0.00: the credit is 0.00, accepted, no hold", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(
      soldOn([
        { id: "u-a", qty: 1, subtotal: 0 },
        { id: "u-b", qty: 2, subtotal: 0 },
      ]),
    );
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 0, taxAmount: 0, priceSource: "SOURCE_INVOICE" });
    expect(q.total).toBe(0);
  });

  it("G4: G1 with the two line uuids swapped (the read lands on the free line): the same 8.33", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(soldOn([FREE, PAID], "u-free"));
    const q = await quote(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 8.33, priceSource: "SOURCE_INVOICE" });
  });

  it("G5: two invoices on the same day, created a minute apart: the read orders by createdAt then id, and the newer one's $11 prices", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(lastSale({ subtotal: 11 })); // the newer by createdAt; the older was $9
    const q = await quote(1);
    expect(db.invoiceItem.findFirst.mock.calls[0][0].orderBy).toEqual([
      { invoice: { issueDate: "desc" } },
      { invoice: { createdAt: "desc" } },
      { invoice: { id: "desc" } },
    ]);
    expect(q.chunks[0]).toMatchObject({ subtotal: 11 });
  });

  // a pack-less line of 6 pieces for 10.00, 4 back: ONE rounding (6.67), never 1.67 x 4 = 6.68
  const SIX = [{ id: "u-six", qty: 6, subtotal: 10 }];

  it("G6: 6 pieces sold for 10.00, 4 back: 6.67 (one rounding), not 6.68", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(soldOn(SIX));
    const q = await quote(4);
    expect(q.chunks[0]).toMatchObject({
      subtotal: 6.67,
      unitPrice: 1.67,
      priceSource: "SOURCE_INVOICE",
    });
  });

  it("G7: G6 with an override at the shown per-piece default 1.67 x 4: credited 6.67, never 6.68", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(soldOn(SIX));
    const q = await quote(4, { creditUnitPrice: 1.67, overrideReason: "Dented" });
    expect(q.chunks[0].subtotal).toBe(6.67);
    expect(q.total).toBe(q.chunks[0].subtotal + q.chunks[0].taxAmount);
  });

  it("G8: 3 back, the newest pool holds 2 for 150.00 in all, today 100.00: roundMoney(150 x 3 / 2) = 225.00 wins over 300.00", async () => {
    await setup(price(100));
    db.invoiceItem.findFirst.mockResolvedValue(soldOn([{ id: "u-two", qty: 2, subtotal: 150 }]));
    const q = await quote(3);
    expect(q.chunks[0]).toMatchObject({ subtotal: 225, priceSource: "SOURCE_INVOICE" });
  });

  it("G8b: the same pool, today 12.00: today's 36.00 is lower and wins, today's source", async () => {
    await setup();
    db.invoiceItem.findFirst.mockResolvedValue(soldOn([{ id: "u-two", qty: 2, subtotal: 150 }]));
    const q = await quote(3);
    expect(q.chunks[0]).toMatchObject({ subtotal: 36, priceSource: "BASE" });
  });
});
