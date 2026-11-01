/**
 * SA-1060 PR-2 (what a no-sale credit means): a chunk of goods the customer was never sold, ever, carries no sales tax
 * (B463's own rule: never credit a tax that was not charged) and is flagged `neverSold` so the capture does not restock it.
 *
 * "Never sold" is ONE predicate, `neverSoldToCustomer`, read from the same whole-history matching-set read that
 * `lifetimeExhausted` already makes, cached per product: at most one read per product, and only for a no-sale chunk.
 * A sold-before chunk (a live invoice line outside the 90-day window) and a matched chunk are unchanged.
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

const invoiceWith = (taxAmount: number, lineTaxRate: number) => ({
  orderId: "ord-1",
  subtotal: 20,
  discount: 0,
  taxAmount,
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
      taxRate: lineTaxRate,
      categoryTaxAmount: 0,
    },
  ],
});

describe("SA-1060 PR-2: a never-sold chunk carries no sales tax and is flagged", () => {
  let service: InlineReturnsQuoteService;
  let db: any;

  const setup = async (tenantTaxRatePercent = "8") => {
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

  /** The window read filters on `issueDate`; the whole-history read filters on `items.some` and has no date. */
  const isLifetimeRead = (args: any) => args?.where?.issueDate === undefined;
  const lifetimeReads = () =>
    db.invoice.findMany.mock.calls.filter(([args]: [any]) => isLifetimeRead(args)).length;

  /** An invoice that exists only OUTSIDE the 90-day window: the window read is empty, the whole-history read finds it. */
  const soldBeforeOnly = (invoice = invoiceWith(1.75, 0.0875)) =>
    db.invoice.findMany.mockImplementation((args: any) =>
      Promise.resolve(isLifetimeRead(args) ? [invoice] : []),
    );

  const quote = (pieces: number, extra: Record<string, unknown> = {}) =>
    service.quote(
      { customerId: "cust-1", items: [{ productId: "prod-1", boxes: 0, pieces, ...extra }] } as any,
      OPERATOR,
    );

  // ─── R-2 ──────────────────────────────────────────────────────────────────────

  it("R-2: a product on none of the customer's invoices, ever, credits no sales tax at an 8% tenant rate (RED on master: 2.4)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    const q = await quote(3);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0].subtotal).toBe(30);
    expect(q.chunks[0].taxAmount).toBe(0);
    expect(q.taxAmount).toBe(0);
    expect(q.total).toBe(30);
  });

  it("R-2b: that chunk says so: neverSold is true (RED on master: the field does not exist)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    const q = await quote(3);
    expect(q.chunks[0].neverSold).toBe(true);
  });

  it("R-2c: a never-sold chunk with a lower credit price still has tax 0 (RED on master: the override re-taxed at 8%)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    const q = await quote(3, { creditUnitPrice: 8, overrideReason: "Damaged box" });
    expect(q.chunks[0]).toMatchObject({
      subtotal: 24,
      priceSource: "MANUAL",
      originalPrice: 10,
    });
    expect(q.chunks[0].taxAmount).toBe(0);
    expect(q.total).toBe(24);
  });

  // ─── G-3 ──────────────────────────────────────────────────────────────────────

  it("G-3 (guard, green on master): a sold-before chunk keeps today's tax, the tenant's current rate", async () => {
    await setup("8");
    soldBeforeOnly();
    const q = await quote(3);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: null, subtotal: 30, taxAmount: 2.4 });
  });

  it("G-3b: a sold-before chunk is not flagged: neverSold is false (RED on master: the field does not exist)", async () => {
    await setup("8");
    soldBeforeOnly();
    const q = await quote(3);
    expect(q.chunks[0].neverSold).toBe(false);
  });

  it("matched chunk: keeps its snapshot tax (guard, green on master) and is not flagged (RED on master: the field does not exist)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    const q = await quote(2);
    expect(q.chunks).toHaveLength(1);
    expect(q.chunks[0]).toMatchObject({ sourceOrderId: "ord-1", subtotal: 20, taxAmount: 1.75 });
    expect(q.chunks[0].neverSold).toBe(false); // red on master
  });

  // ─── G-10 ─────────────────────────────────────────────────────────────────────

  it("G-10 (guard, green on master): a lower-only override on a matched chunk gives today's result", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    const q = await quote(2, { creditUnitPrice: 8, overrideReason: "Dented" });
    expect(q.chunks[0]).toMatchObject({
      sourceOrderId: "ord-1",
      subtotal: 16,
      taxAmount: 1.4,
      priceSource: "MANUAL",
      originalPrice: 10,
      unitPrice: 8,
    });
  });

  it("G-10b (guard, green on master): a lower-only override on a sold-before chunk keeps today's tax", async () => {
    await setup("8");
    soldBeforeOnly();
    const q = await quote(3, { creditUnitPrice: 8, overrideReason: "Dented" });
    expect(q.chunks[0]).toMatchObject({ subtotal: 24, taxAmount: 1.92, priceSource: "MANUAL" });
  });

  // ─── the read: one per product, only for a no-sale chunk ──────────────────────

  it("the whole-history read happens once for a never-sold product, however many items name it (guard: one on master too)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    await service.quote(
      {
        customerId: "cust-1",
        items: [
          { productId: "prod-1", boxes: 0, pieces: 1 },
          { productId: "prod-1", boxes: 0, pieces: 2 },
        ],
      } as any,
      OPERATOR,
    );
    expect(lifetimeReads()).toBe(1);
  });

  it("a fully matched return makes no whole-history read at all (guard)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    await quote(2);
    expect(lifetimeReads()).toBe(0);
  });

  it("an over-return of a product with a window line is sold, not never-sold, and makes at most one whole-history read (guard)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    const q = await quote(3); // 2 matched + 1 beyond the sale
    const over = q.chunks.find((c) => !c.sourceOrderId)!;
    expect(over).toMatchObject({ subtotal: 10, taxAmount: 0.88 });
    expect(lifetimeReads()).toBeLessThanOrEqual(1);
  });

  it("an over-return of a product with a window line is not flagged: neverSold is false (RED on master: the field does not exist)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    const q = await quote(3);
    expect(q.chunks.find((c) => !c.sourceOrderId)!.neverSold).toBe(false);
  });
});
