/**
 * SA-1060 PR-2 (what a no-sale credit means): a chunk of goods the customer was never sold, ever, carries no sales tax
 * (B463's own rule: never credit a tax that was not charged) and is flagged `neverSold` so the capture does not restock it.
 *
 * "Never sold" is ONE predicate, `neverSoldToCustomer` (A-4): its own `invoiceItem.findFirst` over the customer's live invoice
 * lines of the product, with or without an order, cached per product, asked only for a product with a no-sale chunk. The
 * real-Postgres rows (NS-1 to NS-12) are in inline-returns-never-sold.a4.db.spec.ts; this file pins the read's shape on a
 * mock (a mock accepts any `where`, so the values are never trusted here). A sold-before chunk is a product whose read finds a
 * line; a matched chunk is unchanged.
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
  const soldBeforeOnly = (invoice = invoiceWith(1.75, 0.0875)) => {
    db.invoiceItem.findFirst.mockResolvedValue({ id: "item-old" }); // A-4: the never-sold read finds the live sale
    return db.invoice.findMany.mockImplementation((args: any) =>
      Promise.resolve(isLifetimeRead(args) ? [invoice] : []),
    );
  };

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
    db.invoiceItem.findFirst.mockResolvedValue({ id: "item-1" });
    const q = await quote(3); // 2 matched + 1 beyond the sale
    const over = q.chunks.find((c) => !c.sourceOrderId)!;
    expect(over).toMatchObject({ subtotal: 10, taxAmount: 0.88 });
    expect(lifetimeReads()).toBeLessThanOrEqual(1);
  });

  it("an over-return of a product with a window line is not flagged: neverSold is false (RED on master: the field does not exist)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([invoiceWith(1.75, 0.0875)]);
    db.invoiceItem.findFirst.mockResolvedValue({ id: "item-1" });
    const q = await quote(3);
    expect(q.chunks.find((c) => !c.sourceOrderId)!.neverSold).toBe(false);
  });

  // ─── NS-14 (SA-1060 A-4): the never-sold read is its own findFirst, once per product per quote ───

  it("NS-14: two items of one never-sold product make ONE never-sold read (a single findFirst)", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    db.invoiceItem.findFirst.mockResolvedValue(null);
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
    expect(db.invoiceItem.findFirst).toHaveBeenCalledTimes(1);
  });

  it("the never-sold read: one findFirst, customerId and productId set, qty > 0, no order filter, live statuses only", async () => {
    await setup("8");
    db.invoice.findMany.mockResolvedValue([]);
    db.invoiceItem.findFirst.mockResolvedValue(null);
    await quote(3);
    expect(db.invoiceItem.findFirst).toHaveBeenCalledTimes(1);
    const where = db.invoiceItem.findFirst.mock.calls[0][0].where;
    expect(where.productId).toBe("prod-1");
    expect(where.qty).toEqual({ gt: 0 });
    expect(where.invoice.customerId).toBe("cust-1");
    expect(where.invoice).not.toHaveProperty("orderId"); // an invoice with no order is a sale
    expect(where.invoice).not.toHaveProperty("id"); // nothing excluded outside an order edit
    expect(where.invoice.OR).toEqual([
      { status: { notIn: ["DRAFT", "VOID"] } }, // ACCRUAL_REVENUE_STATUSES: WRITTEN_OFF is a sale
      { status: "DRAFT", order: { status: { in: ["DELIVERED", "PARTIALLY_DELIVERED"] } } },
    ]);
  });

  it("an order edit's quote leaves the invoices the edit reverts out of the never-sold read (the same ids the dry run excludes)", async () => {
    await setup("8");
    db.invoice.findMany.mockImplementation((args: any) =>
      Promise.resolve(
        args?.where?.status?.in
          ? [{ id: "inv-sent", invoiceNumber: "I-1", internalNotes: null, depositPercent: null }]
          : [],
      ),
    );
    db.order.findFirst.mockResolvedValue({
      id: "ord-edit",
      status: "CONFIRMED",
      fulfillPath: "ROUTE",
      shippedAt: null,
      tenantId: "t1",
    });
    db.invoiceItem.findFirst.mockResolvedValue(null);
    await service.quote(
      {
        customerId: "cust-1",
        editingOrderId: "ord-edit",
        items: [{ productId: "prod-1", boxes: 0, pieces: 3 }],
      } as any,
      OPERATOR,
    );
    expect(db.order.findFirst.mock.calls[0][0].where).toEqual({
      id: "ord-edit",
      customerId: "cust-1",
    });
    expect(db.invoiceItem.findFirst.mock.calls[0][0].where.invoice.id).toEqual({
      notIn: ["inv-sent"],
    });
  });
});
