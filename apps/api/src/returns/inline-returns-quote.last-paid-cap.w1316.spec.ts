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

/** The customer's newest live sale of the product, as the last-sale read returns it. */
const lastSale = (o: { qty?: number; subtotal: number; unitsPerBox?: number | null }) => ({
  id: "item-old",
  boxes: null,
  unitsPerBox: o.unitsPerBox ?? null,
  invoice: {
    taxAmount: 0,
    discount: 0,
    items: [
      {
        id: "item-old",
        systemKind: null,
        description: null,
        qty: o.qty ?? 1,
        subtotal: o.subtotal,
        taxRate: 0,
        categoryTaxAmount: 0,
      },
    ],
  },
});

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
      { id: "desc" },
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
});
