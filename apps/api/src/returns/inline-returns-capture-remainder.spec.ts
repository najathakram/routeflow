/**
 * SA-773: an inline return's capture is a value-giver the moment it is NOT held (store credit is minted right after it, and a
 * refund is recorded against it): captureInTx asks the refundable remainder under the source Order lock it holds and the source
 * invoice rows it writes, before it creates the return. The per-line headroom does not see an amount-only (manual) credit note,
 * so $50 credited to a $50 invoice and then a counter return of all its goods as store credit minted $50 more.
 * captureAndIssueInTx (the order-create path) goes through captureInTx, so it is covered by the same read.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
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
  forcePasswordChange: false,
  tenantId: "t1",
  tenantSlug: "acme",
  username: "admin",
  status: "ACTIVE",
} as JwtPayload;

const priced = () => ({
  chunks: [
    {
      sourceOrderId: "src-order-1",
      sourceInvoiceItemId: "invitem-1",
      sourceOrderItemId: "orderitem-1",
      productId: "prod-1",
      pieces: 5,
      subtotal: 50,
      taxAmount: 0,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE" as const,
      unitPrice: 10,
    },
  ],
  subtotal: 50,
  taxAmount: 0,
  categoryTax: 0,
  total: 50,
  productBreakdown: {},
});

const line = {
  id: "invitem-1",
  productId: "prod-1",
  qty: 5,
  subtotal: 50,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  product: { unitsPerBox: null },
};

describe("InlineReturnsService.capture: the refundable remainder before an immediate credit (SA-773)", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  let amountOnly: any[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    amountOnly = [];
    creditNotes = {
      mintStandaloneInTx: jest
        .fn()
        .mockResolvedValue({ id: "cn-1", customerId: "cust-1", amount: 50 }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({ applied: 0, unapplied: 0 }),
    };
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-1",
      total: 1000,
      status: "PENDING",
      routeRunId: "run-1",
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.create.mockImplementation(async ({ data }: any) => ({
      id: "ret-1",
      ...data,
      items: (data.items?.create ?? []).map((i: any, idx: number) => ({ id: `ri-${idx}`, ...i })),
    }));
    prisma.return.findFirst.mockResolvedValue(null);
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      status: "RECEIVED",
    }));
    prisma.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
      where?.id?.in ? [{ id: "invitem-1", invoiceId: "inv-1" }] : [line],
    );
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) =>
      where?.OR
        ? [{ id: "inv-1", orderId: "src-order-1", status: "PAID", items: [line] }]
        : [{ id: "inv-1" }],
    );
    prisma.creditNote.findMany.mockImplementation(async ({ where }: any) =>
      where?.items?.none && where?.invoiceId?.in ? amountOnly : [],
    );
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseReturnEntries: jest.fn().mockResolvedValue(undefined),
            unreverseReturnEntries: jest.fn(),
          },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("RET-1") },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        {
          provide: InlineReturnsQuoteService,
          useValue: { priceInlineReturn: jest.fn().mockImplementation(async () => priced()) },
        },
        {
          provide: IdempotencyService,
          useValue: { acquireLock: jest.fn(), hashFor: jest.fn((...a: unknown[]) => a.join(":")) },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  const dto = {
    customerId: "cust-1",
    orderId: "ord-carrying",
    items: [{ productId: "prod-1", qty: 5 }],
    returnKey: "nonce-1",
  };
  const failure = async (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => null,
      (e: any) => e,
    );

  it("a $50 amount-only credit note on the $50 invoice, then a counter return of all its goods: 409 RETURN_EXCEEDS_REFUNDABLE, no return created, no credit minted", async () => {
    amountOnly = [{ id: "cn-manual", invoiceId: "inv-1", amount: 50, status: "ISSUED" }];
    const err = await failure(service.capture(dto as any, OPERATOR));
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      invoiceId: "inv-1",
      remainingValue: 0,
    });
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
  });

  it("the order-create path (captureAndIssueInTx) is refused by the same read before it creates the return or mints", async () => {
    amountOnly = [{ id: "cn-manual", invoiceId: "inv-1", amount: 50, status: "ISSUED" }];
    const err = await failure(
      service.captureAndIssueInTx(prisma as any, dto as any, OPERATOR, {
        creditNoteNumber: "CN-1",
      }),
    );
    expect(err.getResponse()).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE" });
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
  });

  it("nothing credited before: the capture goes through and mints the credit", async () => {
    await service.capture(dto as any, OPERATOR);
    expect(prisma.return.create).toHaveBeenCalledTimes(1);
  });

  it("a $20 manual credit leaves $30: a return of all the goods ($50) is refused with $30 left", async () => {
    amountOnly = [{ id: "cn-manual", invoiceId: "inv-1", amount: 20, status: "ISSUED" }];
    const err = await failure(service.capture(dto as any, OPERATOR));
    expect(err.getResponse()).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      remainingValue: 30,
    });
  });

  describe("approve() of a held capture reads the remainder before it restocks or mints", () => {
    const held = (hold: string) => ({
      id: "ret-held",
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: hold,
      heldAmount: 50,
      creditNoteId: null,
      customerId: "cust-1",
      orderId: "ord-carrying",
      returnNumber: "RET-1",
      items: [
        {
          productId: "prod-1",
          qty: 5,
          sourceOrderId: "src-order-1",
          sourceInvoiceItemId: "invitem-1",
          subtotal: 50,
          taxAmount: 0,
          categoryTax: 0,
        },
      ],
    });

    it.each(["DRIVER_CAP", "ALREADY_RETURNED"])(
      "%s hold, the goods already credited by an amount-only note: 409 RETURN_EXCEEDS_REFUNDABLE, nothing restocked or minted",
      async (hold) => {
        amountOnly = [{ id: "cn-manual", invoiceId: "inv-1", amount: 50, status: "ISSUED" }];
        prisma.return.findFirst.mockResolvedValue(held(hold));
        const err = await failure(
          service.approve("ret-held", OPERATOR, { reason: "checked" } as any),
        );
        expect(err).toBeInstanceOf(ConflictException);
        expect(err.getResponse()).toMatchObject({
          code: "RETURN_EXCEEDS_REFUNDABLE",
          remainingValue: 0,
        });
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
        expect(prisma.stockMovement.create).not.toHaveBeenCalled();
      },
    );

    it("nothing else took the goods: the approval mints as before", async () => {
      prisma.return.findFirst.mockResolvedValue(held("DRIVER_CAP"));
      await service.approve("ret-held", OPERATOR);
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
    });
  });
});
