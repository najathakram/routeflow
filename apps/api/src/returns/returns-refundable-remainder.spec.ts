/**
 * SA-773: every REFUND path asks the one refundable remainder under the locks it already holds, before its claim: the STANDARD
 * `processRefund` claim (store credit and recorded refund alike), the INLINE `refund()` and the INLINE `storeCreditInstead()`.
 * Mocked here (the wiring, the order of the reads, the 409 body); the stored-row proof is returns-refundable-remainder.db.spec.ts.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { ReturnsService } from "./returns.service";
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

const failure = async (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => null,
    (e: any) => e,
  );
const bodyOf = (e: any) => e?.getResponse?.() ?? {};

const billedLine = (over: Record<string, unknown> = {}) => ({
  id: "il-1",
  productId: "p1",
  qty: 10,
  subtotal: 100,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  product: { unitsPerBox: null },
  ...over,
});

describe("SA-773: the STANDARD refund claim reads the refundable remainder under the locks", () => {
  let service: ReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotesCreate: jest.Mock;
  let raw: string[];
  /** the other (counted) STANDARD returns on the order, as the remainder's read sees them */
  let otherReturns: any[];
  let remainderReads: number[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    creditNotesCreate = jest.fn().mockResolvedValue({ id: "cn-1" });
    raw = [];
    remainderReads = [];
    otherReturns = [];
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          raw.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
      }),
    );
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) => {
      if (where?.OR) {
        remainderReads.push(raw.length); // how many statements had run when the remainder was read
        return [{ id: "inv-1", orderId: "ord-1", status: "SENT", items: [billedLine()] }];
      }
      if (where?.id?.in)
        return [
          {
            id: "inv-1",
            status: "SENT",
            total: 100,
            payments: [{ amount: 100, status: "PAID", method: "CASH" }],
          },
        ];
      return [{ id: "inv-1" }];
    });
    // the cash cap's own read filters on status REFUNDED; the remainder's read does not (it filters in code)
    prisma.return.findMany.mockImplementation(async ({ where }: any) =>
      where?.status ? [] : otherReturns,
    );
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.update.mockResolvedValue({});
    prisma.return.findFirst.mockResolvedValue({
      id: "ret-1",
      status: "RECEIVED",
      kind: "STANDARD",
    });
    prisma.invoicePayment.findMany.mockResolvedValue([
      { amount: 100, invoice: { orderId: "ord-1" } },
    ]);
    prisma.return.findUnique.mockImplementation(async (args: any) =>
      args?.include?.order
        ? {
            id: "ret-1",
            returnNumber: "RET-1",
            status: "RECEIVED",
            kind: "STANDARD",
            customerId: "cust-1",
            orderId: "ord-1",
            items: [{ productId: "p1", qty: 2 }],
            order: {
              id: "ord-1",
              orderNumber: "ORD-1",
              counterSale: false,
              registerKey: null,
              invoices: [
                {
                  id: "inv-1",
                  invoiceNumber: "N-1",
                  status: "SENT",
                  total: 100,
                  items: [billedLine()],
                },
              ],
              lineItems: [{ productId: "p1", qty: 10, unitPrice: 10, subtotal: 100 }],
            },
          }
        : { id: "ret-1", status: "REFUNDED", refundAmount: 20, refundTender: null },
    );
    const mod = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitReturnCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: { create: creditNotesCreate } },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(ReturnsService);
  });

  const refund = (method: "CREDIT_NOTE" | "EXTERNAL_REFUND") =>
    service.processRefund("ret-1", { method } as any);
  const otherReturn = (qty: number) => ({
    id: "ret-9",
    orderId: "ord-1",
    kind: "STANDARD",
    status: "RECEIVED",
    items: [{ productId: "p1", qty }],
  });

  it.each(["CREDIT_NOTE", "EXTERNAL_REFUND"] as const)(
    "%s: goods another return already reserves -> 409 RETURN_EXCEEDS_REFUNDABLE with what is left, nothing claimed or minted",
    async (method) => {
      otherReturns = [otherReturn(9)]; // 10 billed, 9 reserved by another return: 1 left, this return wants 2
      const err = await failure(refund(method));
      expect(err).toBeInstanceOf(ConflictException);
      expect(bodyOf(err)).toMatchObject({
        code: "RETURN_EXCEEDS_REFUNDABLE",
        invoiceId: "inv-1",
        productId: "p1",
        remainingQty: 1,
        remainingValue: 10,
      });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(creditNotesCreate).not.toHaveBeenCalled();
    },
  );

  it.each(["CREDIT_NOTE", "EXTERNAL_REFUND"] as const)(
    "%s: the return itself is not counted against its own remainder: what fits still claims",
    async (method) => {
      otherReturns = [otherReturn(8), { ...otherReturn(2), id: "ret-1" }]; // ret-1 is this return: excluded
      await refund(method);
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    },
  );

  it("a REJECTED or CANCELLED return reserves nothing", async () => {
    otherReturns = [
      { ...otherReturn(9), status: "REJECTED" },
      { ...otherReturn(9), id: "ret-8", status: "CANCELLED" },
    ];
    await refund("CREDIT_NOTE");
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
  });

  it("the remainder is read AFTER the Return, Order and invoice locks and BEFORE the claim", async () => {
    await refund("CREDIT_NOTE");
    const lastLock = raw.map((t) => /FOR UPDATE/.test(t)).lastIndexOf(true);
    expect(lastLock).toBeGreaterThanOrEqual(2);
    expect(remainderReads).toHaveLength(1);
    expect(remainderReads[0]).toBeGreaterThan(lastLock);
  });
});

describe("SA-773: the INLINE refund and store-credit conversion read the refundable remainder", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let row: Record<string, any>;
  let raw: string[];
  let priorInline: any[];
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  const operator = { sub: "user-op", role: "OPERATOR", tenantId: "t1" } as any;

  beforeEach(async () => {
    prisma = createMockPrisma();
    raw = [];
    priorInline = [];
    row = {
      id: "ret-1",
      kind: "INLINE",
      status: "RECEIVED",
      holdReason: null,
      heldAmount: null,
      creditNoteId: null,
      refundMethod: "EXTERNAL_REFUND",
      refundAmount: null,
      refundedAt: null,
      customerId: "cust-1",
      orderId: "ord-carrying",
      returnNumber: "RET-1",
      creditSubtotal: 28,
      creditTax: 2,
      creditCategoryTax: 0,
      items: [
        {
          productId: "prod-1",
          qty: 6,
          restock: true,
          sourceOrderId: "src-order-1",
          sourceInvoiceItemId: "invitem-1",
          subtotal: 28,
          taxAmount: 2,
          categoryTax: 0,
        },
      ],
    };
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          raw.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
      }),
    );
    prisma.return.findFirst.mockImplementation(async () => ({ ...row }));
    prisma.return.findUnique.mockImplementation(async () => ({ ...row }));
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-1" }]);
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) =>
      where?.OR
        ? [
            {
              id: "inv-1",
              orderId: "src-order-1",
              status: "PAID",
              items: [billedLine({ id: "invitem-1", productId: "prod-1", qty: 6, subtotal: 30 })],
            },
          ]
        : [
            {
              id: "inv-1",
              status: "PAID",
              total: 30,
              payments: [{ amount: 30, status: "PAID", method: "CASH" }],
            },
          ],
    );
    prisma.returnItem.findMany.mockImplementation(async ({ where }: any) =>
      where?.return?.status ? [] : priorInline,
    );
    prisma.invoicePayment.findMany.mockResolvedValue([
      { amount: 30, invoice: { orderId: "src-order-1" } },
    ]);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findFirst.mockResolvedValue(null);
    creditNotes = {
      mintStandaloneInTx: jest.fn().mockResolvedValue({ id: "cn-1", amount: 30 }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({}),
    };
    const mod = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseReturnEntries: jest.fn(), unreverseReturnEntries: jest.fn() },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("N-1") },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: InlineReturnsQuoteService, useValue: { priceInlineReturn: jest.fn() } },
        {
          provide: IdempotencyService,
          useValue: { acquireLock: jest.fn(), hashFor: jest.fn((...a: unknown[]) => a.join(":")) },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  const otherInlineReturn = (qty: number, subtotal: number) => ({
    productId: "prod-1",
    qty,
    sourceOrderId: "src-order-1",
    subtotal,
    taxAmount: 0,
    categoryTax: 0,
    return: { id: "ret-0", kind: "INLINE", status: "RECEIVED" },
  });

  it("refund(): goods another return already took -> 409 RETURN_EXCEEDS_REFUNDABLE, the claim never runs", async () => {
    priorInline = [otherInlineReturn(6, 30)]; // the whole line is already reserved by another return
    const err = await failure(
      service.refund("ret-1", { tender: "CASH", expectedAmount: 30 } as any, operator),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      code: "RETURN_EXCEEDS_REFUNDABLE",
      invoiceId: "inv-1",
      productId: "prod-1",
      remainingQty: 0,
      remainingValue: 0,
    });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("refund(): the remainder leaves room for this return (itself excluded): the refund claims", async () => {
    priorInline = [
      { ...otherInlineReturn(6, 28), return: { id: "ret-1", kind: "INLINE", status: "RECEIVED" } },
    ];
    await service.refund("ret-1", { tender: "CASH", expectedAmount: 30 } as any, operator);
    expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
  });

  it("refund(): the remainder is read after the order and invoice locks and before the claim", async () => {
    let readAt = -1;
    const base = prisma.invoice.findMany.getMockImplementation()!;
    prisma.invoice.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.OR) readAt = raw.length;
      return base(args);
    });
    await service.refund("ret-1", { tender: "CASH", expectedAmount: 30 } as any, operator);
    const lastLock = raw.map((t) => /FOR UPDATE/.test(t)).lastIndexOf(true);
    expect(readAt).toBeGreaterThan(lastLock);
    expect(prisma.invoice.findMany.mock.invocationCallOrder.length).toBeGreaterThan(0);
  });

  it("storeCreditInstead(): goods already taken -> 409 RETURN_EXCEEDS_REFUNDABLE, nothing minted, intent not cleared", async () => {
    priorInline = [otherInlineReturn(6, 30)];
    const err = await failure(service.storeCreditInstead("ret-1", operator));
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({ code: "RETURN_EXCEEDS_REFUNDABLE", remainingQty: 0 });
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });
});
