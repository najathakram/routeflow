/**
 * B463 (SA-758 CR-1): the two open PR-1c tax follow-ups of the inline return pricing.
 *
 * (1) The tax of an UNREFERENCED chunk (goods beyond what the matched invoice lines had). Its rate falls back to the
 *     product's candidate invoice line's snapshot rate. When that invoice charged NO tax at all (m-7: invoice taxAmount 0),
 *     the matched chunks are untaxed, so the over-return of the same product is untaxed too: crediting a tax the sale never
 *     charged is a credit above what the customer paid. Never invented; fail closed.
 * (2) m-7's excise-only netting: an invoice with no sales tax but an excise (category) tax on the line. The matched chunk
 *     credits the line's excise share and NO sales tax. Pinned as the intended behaviour (it was correct; it had no test).
 */
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

describe("B463: the tax of unreferenced and excise-only return chunks", () => {
  let service: InlineReturnsQuoteService;
  let db: any;

  const setup = async (tenantTaxRatePercent: string | null = null) => {
    const prisma = createMockPrisma();
    db = prisma.forTenant();
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        {
          provide: SystemConfigService,
          useValue: { get: jest.fn().mockResolvedValue(tenantTaxRatePercent) },
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
  };

  /** One invoice, one line of 2 pieces at $10.00 (so $20.00), with the given snapshot tax figures. */
  const sold = (inv: { taxAmount: number; lineTaxRate: number; categoryTax?: number }) =>
    db.invoice.findMany.mockResolvedValue([
      {
        orderId: "ord-1",
        subtotal: 20,
        discount: 0,
        taxAmount: inv.taxAmount,
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
            taxRate: inv.lineTaxRate,
            categoryTaxAmount: inv.categoryTax ?? 0,
          },
        ],
      },
    ]);

  const quote = (pieces: number) =>
    service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", boxes: 0, pieces }] } as any,
      OPERATOR,
    );

  it("(1) an over-return of a product whose invoice charged NO tax is untaxed (red: it was taxed at the line's snapshot rate)", async () => {
    await setup();
    sold({ taxAmount: 0, lineTaxRate: 0.0875 });
    const q = await quote(3); // 2 matched + 1 beyond the sale
    const matched = q.chunks.find((c) => c.sourceOrderId);
    const over = q.chunks.find((c) => !c.sourceOrderId);
    expect(matched).toMatchObject({ pieces: 2, subtotal: 20, taxAmount: 0 });
    expect(over).toMatchObject({ pieces: 1, subtotal: 10, taxAmount: 0 });
    expect(q.taxAmount).toBe(0);
  });

  it("(1) control: an invoice that DID charge tax still taxes the over-return at the line's snapshot rate", async () => {
    await setup();
    sold({ taxAmount: 1.75, lineTaxRate: 0.0875 });
    const q = await quote(3);
    expect(q.chunks.find((c) => c.sourceOrderId)).toMatchObject({ taxAmount: 1.75 });
    expect(q.chunks.find((c) => !c.sourceOrderId)).toMatchObject({ subtotal: 10, taxAmount: 0.88 });
  });

  it("(1) control: a product on no candidate invoice at all still takes the tenant's CURRENT rate", async () => {
    await setup("10");
    db.invoice.findMany.mockResolvedValue([]);
    const q = await quote(1);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 10, taxAmount: 1 });
  });

  it("(2) excise-only netting: no sales tax on the invoice, the line's excise share is credited and nothing else is taxed", async () => {
    await setup();
    sold({ taxAmount: 0, lineTaxRate: 0.0875, categoryTax: 5 });
    const q = await quote(1);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0]).toMatchObject({ subtotal: 10, taxAmount: 0, categoryTax: 2.5 });
    expect(q.total).toBe(12.5);
  });
});
