/**
 * SA-740 §1 (row 190), the CAPTURE side: the source sale reaches the pricing engine (a walk-in defaults it to the
 * carrying order), and when the source is not the carrying order the capture locks BOTH, id-sorted and tenant-bound
 * (`lockRefundOrders`, the same set and order `refund()` takes), instead of the old untenanted carrying-only lock.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { InlineReturnsService } from "./inline-returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
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

const PRICED = {
  chunks: [
    {
      sourceOrderId: "src-z",
      sourceInvoiceItemId: "invitem-1",
      sourceOrderItemId: "orderitem-1",
      productId: "prod-1",
      pieces: 1,
      subtotal: 10,
      taxAmount: 0,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE" as const,
      unitPrice: 10,
    },
  ],
  subtotal: 10,
  taxAmount: 0,
  categoryTax: 0,
  total: 10,
  productBreakdown: {},
};

/** A `$executeRaw` tagged-template call rendered as text + its bound values (Prisma.join expanded). */
function renderRaw(call: any[]): { text: string; values: unknown[] } {
  const [strings, ...vals] = call;
  const values: unknown[] = [];
  for (const v of vals) {
    if (v && typeof v === "object" && Array.isArray((v as any).values))
      values.push(...(v as any).values);
    else values.push(v);
  }
  return { text: (strings as string[]).join("?"), values };
}

describe("SA-740 §1: captureInTx source sale + locks", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let quote: { priceInlineReturn: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    quote = { priceInlineReturn: jest.fn().mockResolvedValue(PRICED) };
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-1",
      total: 1000,
      status: "DELIVERED",
      routeRunId: null,
    });
    prisma.return.create.mockImplementation(async ({ data }: any) => ({
      id: "ret-1",
      ...data,
      items: (data.items?.create ?? []).map((i: any, idx: number) => ({ id: `ri-${idx}`, ...i })),
    }));
    prisma.return.findFirst.mockResolvedValue(null);
    prisma.return.findMany.mockResolvedValue([]);
    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: {} },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-1") },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: InlineReturnsQuoteService, useValue: quote },
        {
          provide: IdempotencyService,
          useValue: { acquireLock: jest.fn(), hashFor: jest.fn(() => "h") },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  const dto = (over: Record<string, unknown> = {}) =>
    ({
      customerId: "cust-1",
      orderId: "ord-carrying",
      items: [{ productId: "prod-1", boxes: 0, pieces: 1 }],
      returnKey: "k-1",
      ...over,
    }) as any;

  const lockCalls = () =>
    prisma.$executeRaw.mock.calls
      .map(renderRaw)
      .filter((c) => c.text.includes('FROM "Order"') && c.text.includes("FOR UPDATE"));

  it("passes the requested source to the pricing and the carrying order as the walk-in default", async () => {
    await service.captureInTx(prisma, dto({ sourceOrderId: "src-z" }), OPERATOR);
    const [req, , , opts] = quote.priceInlineReturn.mock.calls[0];
    expect(req).toMatchObject({ customerId: "cust-1", sourceOrderId: "src-z" });
    expect(opts).toMatchObject({ defaultSourceOrderId: "ord-carrying" });
  });

  it("with no sourceOrderId the pricing is still told the carrying order (a walk-in defaults to it)", async () => {
    await service.captureInTx(prisma, dto(), OPERATOR);
    const [req, , , opts] = quote.priceInlineReturn.mock.calls[0];
    expect(req.sourceOrderId).toBeUndefined();
    expect(opts).toMatchObject({ defaultSourceOrderId: "ord-carrying" });
  });

  it("locks the carrying AND the source order (id-sorted, tenant-bound) BEFORE pricing when they differ", async () => {
    await service.captureInTx(prisma, dto({ sourceOrderId: "src-a" }), OPERATOR);
    const locks = lockCalls();
    expect(locks).toHaveLength(1);
    expect(locks[0].text).toContain("ORDER BY id");
    expect(locks[0].text).toContain('"tenantId"');
    // sorted: src-a < ord-carrying? no: "ord-carrying" < "src-a" lexicographically
    expect(locks[0].values.slice(0, 2)).toEqual(["ord-carrying", "src-a"]);
    expect(locks[0].values).toContain("test-tenant");
    const lockOrder = prisma.$executeRaw.mock.invocationCallOrder[0];
    // the AUTHORITATIVE pricing (the last call) runs under the locks; SA-773's unlocked dry run before them only finds the Orders
    const calls = quote.priceInlineReturn.mock.invocationCallOrder;
    expect(lockOrder).toBeLessThan(calls[calls.length - 1]);
  });

  it("SA-773: a capture with no named source locks the Orders its dry-run chunks come from, in the SAME first statement (id-sorted with the carrying order)", async () => {
    await service.captureInTx(prisma, dto(), OPERATOR); // PRICED chunks come from src-z
    const locks = lockCalls();
    expect(locks).toHaveLength(1);
    expect(locks[0].values.filter((v) => v === "ord-carrying" || v === "src-z")).toEqual([
      "ord-carrying",
      "src-z",
    ]);
    const calls = quote.priceInlineReturn.mock.invocationCallOrder;
    expect(calls.length).toBe(2); // the dry run, then the pricing under the locks
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeGreaterThan(calls[0]);
    expect(prisma.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(calls[1]);
  });

  it("SA-773: a dry run that fails locks nothing extra; the pricing under the locks still decides", async () => {
    quote.priceInlineReturn.mockRejectedValueOnce(new Error("dry run down"));
    await service.captureInTx(prisma, dto(), OPERATOR);
    expect(lockCalls()[0].values.filter((v) => v === "src-z")).toHaveLength(0);
    // and the chunk's order, found only under the locks, is locked before any source invoice is written
    expect(lockCalls().some((l, i) => i > 0 && l.values.includes("src-z"))).toBe(true);
  });

  it("a capture with no source (or the source = the carrying order) locks only the carrying order, tenant-bound", async () => {
    quote.priceInlineReturn.mockResolvedValue({
      ...PRICED,
      chunks: PRICED.chunks.map((c) => ({ ...c, sourceOrderId: "ord-carrying" })),
    });
    await service.captureInTx(prisma, dto(), OPERATOR);
    await service.captureInTx(
      prisma,
      dto({ sourceOrderId: "ord-carrying", returnKey: "k-2" }),
      OPERATOR,
    );
    const locks = lockCalls();
    expect(locks).toHaveLength(2);
    for (const l of locks) {
      expect(l.text).toContain('"tenantId"');
      expect(l.values.slice(0, 1)).toEqual(["ord-carrying"]);
      expect(l.values.filter((v) => v === "ord-carrying")).toHaveLength(1);
    }
  });

  it("the unlocked preflights price with the same source and default", async () => {
    await service.preflightCapture(dto({ sourceOrderId: "src-z" }), OPERATOR, { routeRunId: null });
    const [req, , , opts] = quote.priceInlineReturn.mock.calls[0];
    expect(req).toMatchObject({ sourceOrderId: "src-z" });
    expect(opts).toMatchObject({ defaultSourceOrderId: "ord-carrying" });
  });
});
