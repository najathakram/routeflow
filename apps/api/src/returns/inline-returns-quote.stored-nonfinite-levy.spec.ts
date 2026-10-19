/**
 * SA-816 (d)2 / register row 593: the inline-return candidate lines read each invoice line's stored levy as
 * `Number(item.categoryTaxAmount) || null`. A stored numeric NaN (node-pg binds a JS NaN as 'NaN', NUMERIC
 * accepts it) is falsy, so it became `null`: the quote (and the capture that prices through the same
 * engine) credited the customer NO levy. It is refused now (400 MONEY_INVARIANT) instead.
 *
 * Master (static read, not run): `quote()` resolved with `categoryTax` 0 on the matched chunk and a
 * total of 10.
 */
import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
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

describe("InlineReturnsQuoteService: a stored non-finite levy is refused, not credited as none (SA-816 (d)2)", () => {
  let service: InlineReturnsQuoteService;
  let db: any;

  beforeEach(async () => {
    const prisma = createMockPrisma();
    db = prisma.forTenant();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: { get: jest.fn().mockResolvedValue(null) } },
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
        pricePerUnit: 10,
        priceTier2: 10,
        priceTier3: 10,
        priceTier4: 10,
        priceTier5: 10,
        unitsPerBox: null,
      },
    ]);
    db.return.findMany.mockResolvedValue([]);
    db.returnItem.findMany.mockResolvedValue([]);
  });

  /** One invoice, one line of 2 pieces at $10.00 (so $20.00), no sales tax, the given stored levy. */
  const sold = (levy: unknown) =>
    db.invoice.findMany.mockResolvedValue([
      {
        orderId: "ord-1",
        subtotal: 20,
        discount: 0,
        taxAmount: 0,
        items: [
          {
            id: "item-1",
            orderItemId: "oi-1",
            productId: "prod-1",
            qty: 2,
            unitPrice: 10,
            subtotal: 20,
            boxes: null,
            pieces: null,
            unitsPerBox: null,
            promoFreeUnits: null,
            taxRate: 0,
            categoryTaxAmount: levy,
          },
        ],
      },
    ]);

  const quote = (pieces: number) =>
    service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", boxes: 0, pieces }] } as any,
      OPERATOR,
    );

  it.each([
    ["the string 'NaN' (a raw pg row)", "NaN"],
    ["Prisma.Decimal('NaN') (a Prisma row)", new Prisma.Decimal("NaN")],
    ["the string 'Infinity'", "Infinity"],
    ["Prisma.Decimal('Infinity')", new Prisma.Decimal("Infinity")],
  ])("refuses %s with MONEY_INVARIANT", async (_label, nan) => {
    sold(nan);
    const err = await quote(1).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.MONEY_INVARIANT,
    });
  });

  it("control: a finite levy is credited pro rata, a zero or absent one credits none (as before)", async () => {
    sold(5);
    expect((await quote(1)).chunks[0]).toMatchObject({ subtotal: 10, categoryTax: 2.5 });
    sold(0);
    expect((await quote(1)).chunks[0]).toMatchObject({ subtotal: 10, taxAmount: 0 });
    sold(null);
    expect((await quote(1)).total).toBe(10);
  });
});
