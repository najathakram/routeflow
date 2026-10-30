/**
 * W-913 (SA-932 §B, §D, red cases 1, 4 and 5): a walk-in return is a refund at the till, never store credit.
 * The inline capture judges it BEFORE anything is written (no Return row, no restock, no mint): a walk-in with
 * resolution STORE_CREDIT, or with NO resolution (an old phone build), is refused 409 WALK_IN_STORE_CREDIT_REFUSED,
 * and a walk-in that cannot be refunded is refused with the cause named. A named customer is unchanged.
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
import { wireStockHelper } from "../inventory/testing/stock-helper-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = (role: string): JwtPayload =>
  ({
    sub: `user-${role}`,
    role,
    forcePasswordChange: false,
    tenantId: "t1",
    tenantSlug: "acme",
    username: role.toLowerCase(),
    status: "ACTIVE",
  }) as JwtPayload;
const OPERATOR = user("OPERATOR");
const DRIVER = user("DRIVER");

/** The refusal's whole body, or the thrown error's name when it is not an HttpException. */
const refusalOf = async (p: Promise<unknown>): Promise<any> =>
  p.then(
    () => null,
    (e: any) => ({ status: e?.getStatus?.(), ...(e?.getResponse?.() ?? { name: e?.name }) }),
  );

const paidInvoice = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  status: "PAID",
  total: 30,
  payments: [{ amount: 30, status: "PAID", method: "CASH" }],
  ...over,
});

const priced = (total = 30) => ({
  chunks: [
    {
      sourceOrderId: "ord-carrying",
      sourceInvoiceItemId: "invitem-1",
      sourceOrderItemId: null,
      productId: "prod-1",
      pieces: 6,
      subtotal: total,
      taxAmount: 0,
      categoryTax: 0,
      priceSource: "SOURCE_INVOICE",
      unitPrice: 5,
    },
  ],
  subtotal: total,
  taxAmount: 0,
  categoryTax: 0,
  total,
  productBreakdown: {},
});

describe("InlineReturnsService.capture: a walk-in return is never store credit (W-913)", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  let quoteService: { priceInlineReturn: jest.Mock };

  const DTO = {
    customerId: "cust-walkin",
    orderId: "ord-carrying",
    items: [{ productId: "prod-1", boxes: 0, pieces: 6 }],
    returnKey: "nonce-1",
  };

  const walkIn = (isWalkIn: boolean | null) =>
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-walkin", isWalkIn });

  /** Nothing the capture can write was written. */
  const nothingWritten = () => {
    expect(prisma.return.create).not.toHaveBeenCalled();
    expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    expect(prisma.product.update).not.toHaveBeenCalled();
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(prisma.creditNote.create).not.toHaveBeenCalled();
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    // The restock runs the real stock helper: the wired tx answers its locked product read and the
    // `app.current_tenant_id` read the restock takes (a test tenant) instead of the plain mock's no rows.
    wireStockHelper(prisma, { ample: true });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-1" }]);
    prisma.invoice.findMany.mockResolvedValue([paidInvoice()]);
    prisma.order.findFirst.mockResolvedValue({
      id: "ord-carrying",
      customerId: "cust-walkin",
      total: 1000,
      status: "PENDING",
      routeRunId: null,
    });
    // no replay row for the key; issueCredit's re-reads see the captured row as a STORE_CREDIT capture left it
    prisma.return.findFirst.mockImplementation(async ({ where }: any) =>
      where?.id
        ? {
            id: "ret-1",
            kind: "INLINE",
            status: "RECEIVED",
            holdReason: null,
            creditNoteId: null,
            refundMethod: null,
            customerId: "cust-walkin",
            orderId: "ord-carrying",
            returnNumber: "RET-1",
            creditSubtotal: 30,
            creditTax: 0,
            creditCategoryTax: 0,
            items: [{ productId: "prod-1", qty: 6, restock: true }],
          }
        : null,
    );
    prisma.return.findUnique.mockResolvedValue({
      id: "ret-1",
      status: "REFUNDED",
      creditNoteId: "cn-1",
      items: [],
    });
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.return.findMany.mockResolvedValue([]);
    prisma.return.create.mockImplementation(async ({ data }: any) => ({
      id: "ret-1",
      ...data,
      items: (data.items?.create ?? []).map((i: any, n: number) => ({ id: `ri-${n}`, ...i })),
    }));
    prisma.auditLog.create.mockResolvedValue({});
    creditNotes = {
      mintStandaloneInTx: jest.fn().mockResolvedValue({ id: "cn-1", amount: 30 }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({}),
    };
    quoteService = { priceInlineReturn: jest.fn().mockResolvedValue(priced()) };

    const mod: TestingModule = await Test.createTestingModule({
      providers: [
        InlineReturnsService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseReturnEntries: jest.fn(),
            unreverseReturnEntries: jest.fn(),
            settleRegulatedLedger: jest.fn().mockResolvedValue({ written: 0, amendedPeriod: null }),
          },
        },
        { provide: CreditNotesService, useValue: creditNotes },
        {
          provide: NumberingService,
          useValue: { reserveNext: jest.fn().mockResolvedValue("N-1") },
        },
        { provide: AddonService, useValue: { hasAddon: jest.fn().mockResolvedValue(true) } },
        { provide: InlineReturnsQuoteService, useValue: quoteService },
        {
          provide: IdempotencyService,
          useValue: { acquireLock: jest.fn(), hashFor: jest.fn((...a: unknown[]) => a.join(":")) },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
    jest.spyOn(service as any, "assertWithinLineHeadroom").mockResolvedValue(undefined);
    jest.spyOn(service as any, "assertDriverOwnsOrder").mockResolvedValue(undefined);
  });

  describe("red case 1: an old phone build sends no resolution", () => {
    it("a walk-in capture with NO resolution is 409 WALK_IN_STORE_CREDIT_REFUSED; nothing restocked or minted", async () => {
      walkIn(true);
      const body = await refusalOf(service.capture(DTO as any, OPERATOR));
      expect(body).toMatchObject({
        status: 409,
        code: "WALK_IN_STORE_CREDIT_REFUSED",
        message: "Nothing changed. A walk-in return is refunded at the till.",
      });
      nothingWritten();
    });

    it("an explicit STORE_CREDIT resolution is refused the same way", async () => {
      walkIn(true);
      const body = await refusalOf(
        service.capture({ ...DTO, resolution: "STORE_CREDIT" } as any, OPERATOR),
      );
      expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
      nothingWritten();
    });

    it("a walk-in REFUND capture of a paid-in-full sale still goes through (the till path)", async () => {
      walkIn(true);
      const out = await service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR);
      expect(out).toMatchObject({ status: "RECEIVED", refundPending: true });
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });
  });

  describe("D: a walk-in that cannot be refunded is refused with its cause named", () => {
    it("red case 4: a DRIVER's walk-in return is refused with the role cause, not store credit", async () => {
      walkIn(true);
      const body = await refusalOf(
        service.capture({ ...DTO, routeRunStopId: "stop-1" } as any, DRIVER),
      );
      expect(body).toMatchObject({
        status: 409,
        code: "WALK_IN_STORE_CREDIT_REFUSED",
        cause: "ROLE",
      });
      expect(body.message).toContain("Ask office staff to refund it.");
      nothingWritten();
    });

    it("a sale not paid in full names that cause", async () => {
      walkIn(true);
      prisma.invoice.findMany.mockResolvedValue([paidInvoice({ payments: [] })]);
      const body = await refusalOf(service.capture(DTO as any, OPERATOR));
      expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
      expect(body.cause).toBe("NOT_PAID_IN_FULL");
      nothingWritten();
    });

    it("a sale paid with store credit names that cause", async () => {
      walkIn(true);
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({ payments: [{ amount: 30, status: "PAID", method: "CREDIT_NOTE" }] }),
      ]);
      const body = await refusalOf(service.capture(DTO as any, OPERATOR));
      expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
      expect(body.cause).toBe("PAID_WITH_STORE_CREDIT");
      nothingWritten();
    });

    it("a zero total names that cause", async () => {
      walkIn(true);
      quoteService.priceInlineReturn.mockResolvedValue(priced(0));
      const body = await refusalOf(service.capture(DTO as any, OPERATOR));
      expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
      expect(body.cause).toBe("ZERO_TOTAL");
      nothingWritten();
    });
  });

  describe("red case 5: a named customer is unchanged", () => {
    it.each([
      ["isWalkIn false", false],
      ["isWalkIn null (every legacy row)", null],
    ])("%s: the STORE_CREDIT capture mints and links the credit as before", async (_n, flag) => {
      walkIn(flag);
      await service.capture(DTO as any, OPERATOR);
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
    });
  });

  describe("storeCreditInstead on a walk-in", () => {
    it("is refused 409 WALK_IN_STORE_CREDIT_REFUSED before the pending refund is touched", async () => {
      walkIn(true);
      const pending = {
        id: "ret-1",
        kind: "INLINE",
        status: "RECEIVED",
        holdReason: null,
        creditNoteId: null,
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: null,
        customerId: "cust-walkin",
        orderId: "ord-carrying",
        returnNumber: "RET-1",
        creditSubtotal: 30,
        creditTax: 0,
        creditCategoryTax: 0,
        items: [
          {
            productId: "prod-1",
            qty: 6,
            sourceOrderId: "ord-carrying",
            sourceInvoiceItemId: "invitem-1",
          },
        ],
      };
      prisma.return.findFirst.mockResolvedValue(pending);
      const body = await refusalOf(service.storeCreditInstead("ret-1", OPERATOR));
      expect(body).toMatchObject({ status: 409, code: "WALK_IN_STORE_CREDIT_REFUSED" });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });
  });
});
