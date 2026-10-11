/**
 * SA-773: a standalone credit note is a value-giver too. `create()` asks the refundable remainder under the invoice lock (the
 * same lock a refund takes) before it mints: more than the goods still have left is 409 CREDIT_EXCEEDS_REFUNDABLE, the mirror
 * of RETURN_EXCEEDS_REFUNDABLE (a refund after a credit note is refused on the refund side). A return's own refund mint
 * (`ledgerReversedByReturn`) is not asked again: its claim already checked the same remainder.
 */
import { Test } from "@nestjs/testing";
import { ConflictException } from "@nestjs/common";
import { CreditNotesService } from "./credit-notes.service";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { createMockPrisma } from "../testing/prisma-mock";

const line = (over: Record<string, unknown> = {}) => ({
  id: "il-1",
  productId: "p1",
  qty: 4,
  subtotal: 20,
  taxRate: 0,
  categoryTaxAmount: 0,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  product: { unitsPerBox: null },
  trackedCategoryId: null,
  ...over,
});

describe("CreditNotesService.create: the refundable remainder (SA-773)", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let raw: string[];
  let readAt: number[];
  /** counted returns on the order, as the remainder's read sees them */
  let returnsOnOrder: any[];
  /** amount-only credit notes of the invoice */
  let amountOnly: any[];
  let creditItems: any[];

  beforeEach(async () => {
    prisma = createMockPrisma();
    raw = [];
    readAt = [];
    returnsOnOrder = [];
    amountOnly = [];
    creditItems = [];
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          raw.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
      }),
    );
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("CN-1") },
        },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
    prisma.customer.findFirst.mockResolvedValue({ id: "c1", businessName: "Acme Retail" });
    prisma.creditNote.create.mockImplementation((args: any) =>
      Promise.resolve({ id: "cn-1", ...args.data, customer: {} }),
    );
    // the invoice the credit is validated against (its total leaves room: the OLD caps do not bind in these cases)
    prisma.invoice.findFirst.mockResolvedValue({
      total: 1000,
      customerId: "c1",
      status: "SENT",
      orderId: "ord-1",
      items: [line()],
    });
    prisma.creditNote.aggregate.mockResolvedValue({ _sum: { amount: 0 } });
    prisma.invoice.count.mockResolvedValue(1);
    // the remainder's reads: the order's invoice with its line, the other returns, the amount-only credit notes
    prisma.invoice.findMany.mockImplementation(async ({ where }: any) => {
      if (!where?.OR) return [];
      readAt.push(raw.length);
      return [{ id: "inv-1", orderId: "ord-1", status: "SENT", items: [line()] }];
    });
    prisma.return.findMany.mockImplementation(async () => returnsOnOrder);
    prisma.creditNote.findMany.mockImplementation(async ({ where }: any) =>
      where?.items?.none ? amountOnly : [],
    );
    // the old per-line headroom filters VOID in its where (the mock honours that); the remainder filters in code
    prisma.creditNoteItem.findMany.mockImplementation(async ({ where }: any) =>
      !where?.invoiceItemId?.in
        ? []
        : where.creditNote
          ? creditItems.filter((i) => i.creditNote?.status !== "VOID")
          : creditItems,
    );
    prisma.invoiceItem.findMany.mockResolvedValue([
      {
        id: "il-1",
        invoiceId: "inv-1",
        productId: "p1",
        qty: 4,
        taxRate: 0,
        boxes: null,
        pieces: null,
        unitsPerBox: null,
        product: { unitsPerBox: null },
      },
    ]);
  });

  const failure = async (p: Promise<unknown>): Promise<any> =>
    p.then(
      () => null,
      (e: any) => e,
    );
  const bodyOf = (e: any) => e?.getResponse?.() ?? {};
  const credit = (amount: number, items = true) =>
    service.create({
      customerId: "c1",
      invoiceId: "inv-1",
      amount,
      ...(items ? { items: [{ invoiceItemId: "il-1", amount }] } : {}),
    });
  const countedReturn = (qty: number, status = "REFUNDED") => ({
    id: "ret-1",
    orderId: "ord-1",
    kind: "STANDARD",
    status,
    items: [{ productId: "p1", qty }],
  });

  it("a refund of the whole line came first, then a $20 credit note for it: 409 CREDIT_EXCEEDS_REFUNDABLE, remainingValue 0, nothing minted", async () => {
    returnsOnOrder = [countedReturn(4)];
    const err = await failure(credit(20));
    expect(err).toBeInstanceOf(ConflictException);
    expect(bodyOf(err)).toMatchObject({
      code: "CREDIT_EXCEEDS_REFUNDABLE",
      invoiceId: "inv-1",
      productId: "p1",
      remainingQty: 0,
      remainingValue: 0,
    });
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
    expect(prisma.creditNoteItem.createMany).not.toHaveBeenCalled();
  });

  it("a partial refund ($8 of the $20 line): a credit of the remaining $12 is minted, $13 is refused with $12 left", async () => {
    returnsOnOrder = [countedReturn(1.6)];
    await credit(12);
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(1);
    prisma.creditNote.create.mockClear();
    const err = await failure(credit(13));
    expect(bodyOf(err)).toMatchObject({ code: "CREDIT_EXCEEDS_REFUNDABLE", remainingValue: 12 });
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  });

  it("a REJECTED or CANCELLED return, and a VOID credit note item, reserve nothing", async () => {
    returnsOnOrder = [
      countedReturn(4, "REJECTED"),
      { ...countedReturn(4, "CANCELLED"), id: "ret-2" },
    ];
    creditItems = [
      {
        invoiceItemId: "il-1",
        creditNoteId: "cn-void",
        qty: 4,
        amount: 20,
        categoryTax: 0,
        creditNote: { status: "VOID" },
      },
    ];
    await credit(20);
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(1);
  });

  it("an amount-only credit note is held to the invoice-level remainder: $15 already out of a $20 invoice leaves $5", async () => {
    amountOnly = [{ id: "cn-old", invoiceId: "inv-1", amount: 15, status: "ISSUED" }];
    const err = await failure(credit(10, false));
    expect(bodyOf(err)).toMatchObject({
      code: "CREDIT_EXCEEDS_REFUNDABLE",
      invoiceId: "inv-1",
      remainingQty: null,
      remainingValue: 5,
    });
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
    await credit(5, false);
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(1);
  });

  it("a return's own refund mint is not asked again (its claim checked the same remainder)", async () => {
    returnsOnOrder = [countedReturn(4)]; // the return being minted for is itself REFUNDED by now
    await service.create(
      {
        customerId: "c1",
        invoiceId: "inv-1",
        amount: 20,
        items: [{ invoiceItemId: "il-1", amount: 20, qty: 4 }],
      },
      { ledgerReversedByReturn: true },
    );
    expect(prisma.creditNote.create).toHaveBeenCalledTimes(1);
  });

  it("the remainder is read inside the transaction, after the invoice lock, before the insert", async () => {
    await credit(20);
    const invoiceLock = raw.findIndex((t) => /FROM "Invoice" WHERE id = \? .*FOR UPDATE/.test(t));
    expect(invoiceLock).toBeGreaterThanOrEqual(0);
    expect(readAt.some((n) => n > invoiceLock)).toBe(true);
  });
});
