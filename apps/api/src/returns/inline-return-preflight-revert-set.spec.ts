import { Test, TestingModule } from "@nestjs/testing";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { InlineReturnsService } from "./inline-returns.service";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { preflightInlineReturn } from "../orders/order-inline-return";

/**
 * #2178 (Opus L1 on #2139) — the order-edit preflight prices an inline return against the matching set
 * AS IT WILL BE after the edit's linked-invoice revert: on an undelivered order that revert turns the
 * order's own SENT invoice into a DRAFT, which §3.1 leaves out. Before this, the preflight still saw
 * that invoice, so a boxed return whose only pack evidence was it passed the preflight, the revert
 * committed, and the in-tx pricing then failed INLINE_RETURN_PACK_UNKNOWN (the B215 class).
 * (Real-Postgres pin: inline-return-preflight-revert.db.spec.ts, run by F2.)
 */

const OPERATOR = {
  sub: "u-op",
  username: "operator",
  role: "OPERATOR",
  status: "ACTIVE",
  forcePasswordChange: false,
} as any;
const ZERO_TAX_SYSTEM_CONFIG = { get: jest.fn().mockResolvedValue(null) };

describe("#2178 — the preflight prices against the post-revert matching set", () => {
  let quote: InlineReturnsQuoteService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let db: any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsQuoteService,
        { provide: PrismaService, useValue: prisma },
        { provide: SystemConfigService, useValue: ZERO_TAX_SYSTEM_CONFIG },
      ],
    }).compile();
    quote = module.get(InlineReturnsQuoteService);
    db = prisma.forTenant();
    db.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1, isTaxExempt: false });
    db.customerPrice.findMany.mockResolvedValue([]);
    db.product.findMany.mockResolvedValue([
      {
        id: "prod-1",
        pricePerUnit: 24,
        priceTier2: 24,
        priceTier3: 24,
        priceTier4: 24,
        priceTier5: 24,
      },
    ]);
    db.invoice.findMany.mockResolvedValue([]);
    db.return.findMany.mockResolvedValue([]);
    db.returnItem.findMany.mockResolvedValue([]);
    db.invoiceItem.findMany.mockResolvedValue([]); // B948: the preflight's line-headroom read (no source line: nothing to cap)
  });

  const request = {
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1, boxes: 0, pieces: 3 }],
  };

  it("priceInlineReturn: excludeInvoiceIds leaves those invoices out of the matching-set query", async () => {
    await quote.priceInlineReturn(request as any, OPERATOR, db, { excludeInvoiceIds: ["inv-own"] });
    expect(db.invoice.findMany.mock.calls[0][0].where.id).toEqual({ notIn: ["inv-own"] });
  });

  it("priceInlineReturn: with nothing to exclude, the query is exactly as before (no id filter)", async () => {
    await quote.priceInlineReturn(request as any, OPERATOR, db);
    expect(db.invoice.findMany.mock.calls[0][0].where).not.toHaveProperty("id");
  });

  it("preflightCapture: with revertOrderId, excludes exactly what the shared revert selector returns", async () => {
    const svc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      quoteService: { priceInlineReturn: jest.fn().mockResolvedValue({ total: 12, chunks: [] }) },
    });
    db.invoice.findMany.mockResolvedValue([
      { id: "inv-own", invoiceNumber: "INV-1", internalNotes: null, depositPercent: null },
    ]);
    await svc.preflightCapture(
      { customerId: "cust-1", orderId: "ord-1", items: request.items },
      OPERATOR,
      { routeRunId: null },
      { revertOrderId: "ord-1" },
    );
    expect(db.invoice.findMany.mock.calls[0][0].where).toMatchObject({
      orderId: "ord-1",
      deliveryBatchId: null,
    });
    expect(svc.quoteService.priceInlineReturn.mock.calls[0][3]).toEqual({
      excludeInvoiceIds: ["inv-own"],
      defaultSourceOrderId: "ord-1", // SA-740: the carrying order is the walk-in's default source
    });
  });

  it("preflightCapture: without revertOrderId, nothing is excluded and the revert set is never read", async () => {
    const svc: any = Object.assign(Object.create(InlineReturnsService.prototype), {
      prisma,
      quoteService: { priceInlineReturn: jest.fn().mockResolvedValue({ total: 12, chunks: [] }) },
    });
    await svc.preflightCapture(
      { customerId: "cust-1", orderId: "ord-1", items: request.items },
      OPERATOR,
      { routeRunId: null },
    );
    expect(db.invoice.findMany).not.toHaveBeenCalled();
    expect(svc.quoteService.priceInlineReturn.mock.calls[0][3]).toEqual({
      excludeInvoiceIds: [],
      defaultSourceOrderId: "ord-1",
    });
  });

  it("preflightInlineReturn: asks for the post-revert set ONLY when the edit's revert runs next", async () => {
    const preflightCapture = jest.fn().mockResolvedValue(5);
    const p: any = { svc: { preflightCapture }, lines: { items: request.items } };
    const order = { id: "ord-1", customerId: "cust-1", routeRunId: null };
    await preflightInlineReturn(p, order, OPERATOR, true);
    expect(preflightCapture.mock.calls[0][3]).toEqual({ revertOrderId: "ord-1" });
    await preflightInlineReturn(p, order, OPERATOR, false);
    expect(preflightCapture.mock.calls[1][3]).toEqual({});
  });
});
