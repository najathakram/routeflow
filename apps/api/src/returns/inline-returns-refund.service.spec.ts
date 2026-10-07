/**
 * SA-727 (counter refund): a cash/card/check refund is a RESOLUTION OF THE RETURN (the existing EXTERNAL_REFUND method),
 * never a negative payment. These are the mocked unit pins of `InlineReturnsService.refund()`, the REFUND capture
 * resolution, the cancel guard (M6) and the quote's additive fields; the transactional invariants (CAS under real locks,
 * rollback, concurrency, net sales) are proven against Postgres in inline-returns-refund.db.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import { InlineReturnsService } from "./inline-returns.service";
import { InlineReturnsQuoteService } from "./inline-returns-quote.service";
import { canRefundRole, inlineReturnAmount, isRefundPending } from "./inline-return-refund";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { NumberingService } from "../import/numbering.service";
import { AddonService } from "../billing/addon.service";
import { IdempotencyService } from "../common/idempotency.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { createMockPrisma } from "../testing/prisma-mock";
import type { JwtPayload } from "../auth/jwt-payload.interface";

const user = (role: string, extra: Partial<JwtPayload> = {}): JwtPayload =>
  ({
    sub: `user-${role}`,
    role,
    forcePasswordChange: false,
    tenantId: "t1",
    tenantSlug: "acme",
    username: role.toLowerCase(),
    status: "ACTIVE",
    ...extra,
  }) as JwtPayload;
const OPERATOR = user("OPERATOR");
const DRIVER = user("DRIVER");

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: any) => e?.getResponse?.()?.code ?? e?.constructor?.name ?? null,
  );

const REFUND = { tender: "CASH", expectedAmount: 30 } as any;

function receivedReturn(over: Record<string, unknown> = {}) {
  return {
    id: "ret-1",
    kind: "INLINE",
    status: "RECEIVED",
    holdReason: null,
    heldAmount: null,
    creditNoteId: null,
    // SA-727a: a return captured for a refund stores its intent: refundMethod set, refundedAt/refundAmount null (pending)
    refundMethod: "EXTERNAL_REFUND",
    refundAmount: null,
    refundedAt: null,
    customerId: "cust-1",
    orderId: "ord-carrying",
    returnNumber: "RET-2026-0001",
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
      },
    ],
    ...over,
  };
}

const paidInvoice = (over: Record<string, unknown> = {}) => ({
  id: "inv-1",
  status: "PAID",
  total: 30,
  payments: [{ amount: 30, status: "PAID", method: "CASH" }],
  ...over,
});

describe("InlineReturnsService.refund (SA-727)", () => {
  let service: InlineReturnsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let row: Record<string, any>;
  let rawCalls: string[];
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  let quoteService: { priceInlineReturn: jest.Mock };
  let addonService: { hasAddon: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    row = receivedReturn();
    rawCalls = [];
    // one tx client for every transaction: records the raw lock statements in order
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray) => {
          rawCalls.push(strings.join("?").replace(/\s+/g, " ").trim());
          return Promise.resolve(0);
        }),
      }),
    );
    prisma.return.findFirst.mockImplementation(async () => ({ ...row }));
    prisma.return.findUnique.mockImplementation(async () => ({ ...row }));
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-1" }]);
    prisma.invoice.findMany.mockResolvedValue([paidInvoice()]);
    prisma.auditLog.create.mockResolvedValue({});
    prisma.auditLog.findFirst.mockResolvedValue(null);
    creditNotes = {
      mintStandaloneInTx: jest.fn().mockResolvedValue({ id: "cn-1", amount: 30 }),
      settleOrderCreditsInTx: jest.fn().mockResolvedValue({}),
    };
    quoteService = { priceInlineReturn: jest.fn() };
    addonService = { hasAddon: jest.fn().mockResolvedValue(true) };

    const mod: TestingModule = await Test.createTestingModule({
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
        { provide: AddonService, useValue: addonService },
        { provide: InlineReturnsQuoteService, useValue: quoteService },
        {
          provide: IdempotencyService,
          useValue: { acquireLock: jest.fn(), hashFor: jest.fn((...a: unknown[]) => a.join(":")) },
        },
      ],
    }).compile();
    service = mod.get(InlineReturnsService);
  });

  it("records the refund: the CAS claim (RECEIVED, no credit note, the stored EXTERNAL_REFUND intent, refundedAt null; never holdReason) sets REFUNDED + the server amount + refundedAt", async () => {
    const out = await service.refund("ret-1", REFUND, OPERATOR);
    expect(prisma.return.updateMany).toHaveBeenCalledWith({
      where: {
        id: "ret-1",
        kind: "INLINE",
        status: "RECEIVED",
        creditNoteId: null,
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: null,
      },
      data: { status: "REFUNDED", refundAmount: 30, refundedAt: expect.any(Date) },
    });
    expect(JSON.stringify(prisma.return.updateMany.mock.calls[0][0].where)).not.toContain(
      "holdReason",
    );
    expect(out).toMatchObject({ id: "ret-1", refundTender: "CASH", refundPending: false });
    // no credit note, no payment write of any kind: the invoice stays as it was
    expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it("M5: ONE awaited audit row {returnId, invoiceIds, amount, tender, actor, impersonatedBy}; the tender is only in the audit meta", async () => {
    await service.refund(
      "ret-1",
      { ...REFUND, tender: "CARD", reason: " customer changed mind " },
      user("OPERATOR", { impersonatedBy: "sa-1" }),
    );
    expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: "user-OPERATOR",
        impersonatedBy: "sa-1",
        action: "inline_return.refund",
        entityType: "Return",
        entityId: "ret-1",
        meta: expect.objectContaining({
          returnId: "ret-1",
          invoiceIds: ["inv-1"],
          amount: 30,
          tender: "CARD",
          actor: "user-OPERATOR",
          impersonatedBy: "sa-1",
        }),
      }),
    });
    // refundMethod stays the literal stored at capture: no new string, no tender in the row
    const data = prisma.return.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("refundMethod");
    expect(JSON.stringify(data)).not.toMatch(/CARD|CASH|CHECK/);
  });

  it("M5 (rollback): an audit failure rejects the whole refund, after the claim ran inside the same transaction", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(service.refund("ret-1", REFUND, OPERATOR)).rejects.toThrow("audit down");
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1); // claim + audit share ONE tx: the DB spec proves the rollback
  });

  it("lock order: Return, then the carrying + source Orders in one id-ordered statement, then the source Invoices id-sorted", async () => {
    await service.refund("ret-1", REFUND, OPERATOR);
    expect(rawCalls).toHaveLength(3);
    expect(rawCalls[0]).toMatch(/FROM "Return" WHERE id = \? FOR UPDATE/);
    expect(rawCalls[1]).toMatch(/FROM "Order" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/);
    expect(rawCalls[2]).toMatch(/FROM "Invoice" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/);
  });

  it("M2: the amount is the server's: a different expectedAmount is 409 REFUND_AMOUNT_CHANGED carrying the real amount, nothing written", async () => {
    const err: any = await service
      .refund("ret-1", { ...REFUND, expectedAmount: 29.99 }, OPERATOR)
      .catch((e) => e);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({ code: "REFUND_AMOUNT_CHANGED", amount: 30 });
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("M2: the amount is exactly what the credit mint issues: roundMoney(subtotal + tax + categoryTax)", async () => {
    // Prisma Decimals reach the service as strings in JSON, and the three parts are summed then rounded to cents
    row = receivedReturn({
      creditSubtotal: "10.0000",
      creditTax: "0.1500",
      creditCategoryTax: "0.1600",
    });
    await expect(
      service.refund("ret-1", { ...REFUND, expectedAmount: 10.31 }, OPERATOR),
    ).resolves.toMatchObject({ refundTender: "CASH" });
    expect(prisma.return.updateMany.mock.calls[0][0].data.refundAmount).toBe(10.31);
  });

  it("M3: an invoice still owing, VOID, written off or with only a PENDING payment is 409 REFUND_NEEDS_PAID_INVOICE, nothing written", async () => {
    for (const inv of [
      paidInvoice({ payments: [{ amount: 10, status: "PAID", method: "CASH" }] }),
      paidInvoice({ status: "VOID" }),
      paidInvoice({ status: "WRITTEN_OFF" }),
      paidInvoice({ payments: [{ amount: 30, status: "PENDING", method: "CHECK" }] }),
    ]) {
      prisma.invoice.findMany.mockResolvedValue([inv]);
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "REFUND_NEEDS_PAID_INVOICE",
      );
    }
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  it("M3 fails closed: a returned line on NO invoice (or whose source line is gone) is not refundable in cash", async () => {
    row = receivedReturn({
      items: [{ productId: "prod-1", qty: 6, sourceOrderId: null, sourceInvoiceItemId: null }],
    });
    expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
      "REFUND_NEEDS_PAID_INVOICE",
    );
    row = receivedReturn();
    prisma.invoiceItem.findMany.mockResolvedValue([]);
    expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
      "REFUND_NEEDS_PAID_INVOICE",
    );
  });

  it("M3: EVERY source invoice must be paid: one paid and one owing is refused", async () => {
    row = receivedReturn({
      items: [
        { productId: "p1", qty: 1, sourceOrderId: "o1", sourceInvoiceItemId: "ii-1" },
        { productId: "p2", qty: 1, sourceOrderId: "o2", sourceInvoiceItemId: "ii-2" },
      ],
    });
    prisma.invoiceItem.findMany.mockResolvedValue([
      { id: "ii-1", invoiceId: "inv-1" },
      { id: "ii-2", invoiceId: "inv-2" },
    ]);
    prisma.invoice.findMany.mockResolvedValue([
      paidInvoice(),
      paidInvoice({ id: "inv-2", payments: [] }),
    ]);
    expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
      "REFUND_NEEDS_PAID_INVOICE",
    );
  });

  it("M1: store credit XOR refund: a return already credited (or credit-resolved) is 409 RETURN_ALREADY_RESOLVED, no write", async () => {
    for (const resolved of [
      { status: "REFUNDED", refundMethod: "CREDIT_NOTE", creditNoteId: "cn-1", refundAmount: 30 },
      { creditNoteId: "cn-1" },
    ]) {
      row = receivedReturn(resolved);
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "RETURN_ALREADY_RESOLVED",
      );
    }
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("a return captured for STORE CREDIT (no stored refund intent) and still RECEIVED is not turned into a refund: 409 RETURN_NOT_REFUNDABLE", async () => {
    row = receivedReturn({ refundMethod: null });
    expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe("RETURN_NOT_REFUNDABLE");
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  it("M1: a lost CAS (another resolution landed between the read and the claim) is 409 RETURN_ALREADY_RESOLVED, no audit row", async () => {
    prisma.return.updateMany.mockResolvedValue({ count: 0 });
    expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe("RETURN_ALREADY_RESOLVED");
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  describe("replay (the return id is the idempotency key)", () => {
    const refunded = () =>
      receivedReturn({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 30,
        refundedAt: new Date(),
      });
    beforeEach(() => {
      row = refunded();
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CASH", amount: 30 } });
    });

    it("the same tender and amount is a 200 with the stored result: no transaction, no second audit row, no second write", async () => {
      const out = await service.refund("ret-1", REFUND, OPERATOR);
      expect(out).toMatchObject({ status: "REFUNDED", refundAmount: 30, refundTender: "CASH" });
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("another tender is 409 RETURN_ALREADY_RESOLVED", async () => {
      expect(await codeOf(service.refund("ret-1", { ...REFUND, tender: "CARD" }, OPERATOR))).toBe(
        "RETURN_ALREADY_RESOLVED",
      );
    });

    it("another amount is 409 RETURN_ALREADY_RESOLVED", async () => {
      expect(
        await codeOf(service.refund("ret-1", { ...REFUND, expectedAmount: 31 }, OPERATOR)),
      ).toBe("RETURN_ALREADY_RESOLVED");
    });

    it("a refund with no audit row to read the tender from is never replayed as a match", async () => {
      prisma.auditLog.findFirst.mockResolvedValue(null);
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "RETURN_ALREADY_RESOLVED",
      );
    });

    it("an audit row whose meta has NO tender (or no meta) is a mismatch: 409, never a replay", async () => {
      for (const meta of [{ amount: 30 }, null]) {
        prisma.auditLog.findFirst.mockResolvedValue({ meta });
        expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
          "RETURN_ALREADY_RESOLVED",
        );
      }
    });
  });

  it("only office roles refund: a DRIVER is 403 before any read", async () => {
    await expect(service.refund("ret-1", REFUND, DRIVER)).rejects.toThrow(ForbiddenException);
    await expect(service.refund("ret-1", REFUND, user("CUSTOMER"))).rejects.toThrow(
      ForbiddenException,
    );
    expect(prisma.return.findFirst).not.toHaveBeenCalled();
  });

  it("the add-on is re-checked by the service: no grant is 403", async () => {
    addonService.hasAddon.mockResolvedValue(false);
    await expect(service.refund("ret-1", REFUND, OPERATOR)).rejects.toThrow(ForbiddenException);
  });

  it("an unknown or STANDARD-kind id is 404", async () => {
    prisma.return.findFirst.mockResolvedValue(null);
    await expect(service.refund("nope", REFUND, OPERATOR)).rejects.toThrow(NotFoundException);
    expect(prisma.return.findFirst).toHaveBeenCalledWith({ where: { id: "nope", kind: "INLINE" } });
  });

  it("a held, rejected, cancelled or $0 return is 409 RETURN_NOT_REFUNDABLE", async () => {
    for (const over of [
      { holdReason: "DRIVER_CAP" },
      { status: "REJECTED" },
      { status: "CANCELLED" },
      { creditSubtotal: 0, creditTax: 0 },
    ]) {
      row = receivedReturn(over);
      expect(
        await codeOf(service.refund("ret-1", { ...REFUND, expectedAmount: 0.01 }, OPERATOR)),
      ).toBe("RETURN_NOT_REFUNDABLE");
    }
    expect(prisma.return.updateMany).not.toHaveBeenCalled();
  });

  describe("M6: cancel", () => {
    it("a REFUNDED (refundedAt set) cash/card/check return is 409 RETURN_REFUNDED_CASH: no claim, no restock reversal, nothing written", async () => {
      row = receivedReturn({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 30,
        refundedAt: new Date(),
      });
      expect(await codeOf(service.cancel("ret-1", OPERATOR))).toBe("RETURN_REFUNDED_CASH");
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(prisma.product.update).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("a PENDING refund (refundMethod set, refundedAt null) cancels normally WITH the unrestock", async () => {
      row = receivedReturn(); // the default fixture is a pending refund
      const out = await service.cancel("ret-1", OPERATOR);
      expect(out).toBeDefined();
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.return.updateMany.mock.calls[0][0].data.status).toBe("CANCELLED");
      expect(prisma.product.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { currentStock: { decrement: expect.anything() } } }),
      );
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1);
    });

    it("a store-credit REFUNDED return still cancels as before (the guard keys on a recorded EXTERNAL_REFUND only)", async () => {
      row = receivedReturn({
        status: "REFUNDED",
        refundMethod: "CREDIT_NOTE",
        creditNoteId: "cn-1",
        refundedAt: new Date(),
      });
      (creditNotes as any).cancelStandaloneInTx = jest.fn().mockResolvedValue({});
      await service.cancel("ret-1", OPERATOR);
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("capture resolution (SA-727)", () => {
    const priced = {
      chunks: [
        {
          sourceOrderId: "src-order-1",
          sourceInvoiceItemId: "invitem-1",
          sourceOrderItemId: null,
          productId: "prod-1",
          pieces: 6,
          subtotal: 28,
          taxAmount: 2,
          categoryTax: 0,
          priceSource: "SOURCE_INVOICE",
          unitPrice: 4.67,
        },
      ],
      subtotal: 28,
      taxAmount: 2,
      categoryTax: 0,
      total: 30,
      productBreakdown: {},
    };
    const DTO = {
      customerId: "cust-1",
      orderId: "ord-carrying",
      items: [{ productId: "prod-1", boxes: 0, pieces: 6 }],
      returnKey: "nonce-1",
    };
    beforeEach(() => {
      quoteService.priceInlineReturn.mockResolvedValue(priced);
      jest.spyOn(service as any, "assertWithinLineHeadroom").mockResolvedValue(undefined);
      prisma.order.findFirst.mockResolvedValue({
        id: "ord-carrying",
        customerId: "cust-1",
        total: 1000,
        status: "PENDING",
        routeRunId: null,
      });
      prisma.return.create.mockImplementation(async ({ data }: any) => ({
        id: "ret-1",
        ...data,
        items: (data.items?.create ?? []).map((i: any, n: number) => ({ id: `ri-${n}`, ...i })),
      }));
      // no replay row for the key; the freshly created RECEIVED row is what issueCredit would re-read
      // issueCredit's re-reads see the row as a STORE_CREDIT capture left it (no stored refund intent)
      prisma.return.findFirst.mockImplementation(async ({ where }: any) =>
        where?.id ? { ...receivedReturn({ refundMethod: null }) } : null,
      );
      prisma.return.findMany.mockResolvedValue([]);
      prisma.return.findUnique.mockImplementation(async () => ({
        ...receivedReturn({ refundMethod: null }),
        status: "REFUNDED",
        creditNoteId: "cn-1",
      }));
    });

    it("REFUND: restocks and records the return RECEIVED but mints NO credit note, issues nothing, and says refundPending", async () => {
      const out = await service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR);
      expect(prisma.return.create).toHaveBeenCalledTimes(1);
      expect(prisma.stockMovement.create).toHaveBeenCalledTimes(1); // the existing restock path, unchanged
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.orderCreditNote.create).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).not.toHaveBeenCalled(); // no issue-link claim
      // SA-727a: the refund INTENT is stored on the row at capture; nothing counts as refunded yet
      expect(prisma.return.create.mock.calls[0][0].data).toMatchObject({
        status: "RECEIVED",
        refundMethod: "EXTERNAL_REFUND",
        refundedAt: null,
        refundAmount: null,
      });
      expect(prisma.return.create.mock.calls[0][0].data).not.toHaveProperty("holdReason");
      expect(out).toMatchObject({ status: "RECEIVED", refundPending: true });
      expect(out.creditNoteId ?? null).toBeNull();
    });

    it("STORE_CREDIT (and an omitted resolution) is unchanged: the credit note is minted and linked, no refundPending key", async () => {
      for (const body of [DTO, { ...DTO, resolution: "STORE_CREDIT" }]) {
        creditNotes.mintStandaloneInTx.mockClear();
        const out = await service.capture(body as any, OPERATOR);
        expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
        expect(out).not.toHaveProperty("refundPending");
      }
    });

    it("STORE_CREDIT capture rows are created WITHOUT a stored refund intent", async () => {
      await service.capture(DTO as any, OPERATOR);
      expect(prisma.return.create.mock.calls[0][0].data).not.toHaveProperty("refundMethod");
    });

    describe("a capture REPLAY of a REFUND capture never mints a credit note (SA-727a)", () => {
      const pending = () => ({
        ...receivedReturn(),
        items: [{ productId: "prod-1", qty: 6, restock: true }],
      });
      beforeEach(() => {
        // the unlocked returnKey pre-read finds the pending-refund row; issueCredit's own re-reads would too
        prisma.return.findFirst.mockImplementation(async () => pending());
      });
      it.each([
        ["REFUND resolution", { ...DTO, resolution: "REFUND" }],
        ["the default (STORE_CREDIT) resolution", DTO],
      ])("%s: no mint, no issue claim, no new Return row", async (_n, body) => {
        const out = await service.capture(body as any, OPERATOR);
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
        expect(prisma.return.create).not.toHaveBeenCalled();
        expect(out.creditNoteId ?? null).toBeNull();
      });
    });

    it("issueCredit pre-read, in-lock re-check and CAS all key on refundMethod IS NULL: a pending refund row mints nothing even if reached directly", async () => {
      prisma.return.findFirst.mockImplementation(async () => receivedReturn());
      await (service as any).issueCredit("ret-1");
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      // and the CAS itself (reached by a STORE_CREDIT row) carries refundMethod: null
      prisma.return.findFirst.mockImplementation(async () =>
        receivedReturn({ refundMethod: null }),
      );
      await (service as any).issueCredit("ret-1");
      expect(prisma.return.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            status: "RECEIVED",
            creditNoteId: null,
            refundMethod: null,
          }),
        }),
      );
    });

    it("REFUND for a driver is 403 before any read", async () => {
      await expect(
        service.capture({ ...DTO, resolution: "REFUND", routeRunStopId: "s1" } as any, DRIVER),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.order.findFirst).not.toHaveBeenCalled();
    });

    it("REFUND against an unpaid invoice is refused 409 REFUND_NEEDS_PAID_INVOICE BEFORE any write (no Return row, no restock)", async () => {
      prisma.invoice.findMany.mockResolvedValue([paidInvoice({ payments: [] })]);
      expect(await codeOf(service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR))).toBe(
        "REFUND_NEEDS_PAID_INVOICE",
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("an unpaid invoice does not matter to a STORE_CREDIT capture", async () => {
      prisma.invoice.findMany.mockResolvedValue([paidInvoice({ payments: [] })]);
      await expect(service.capture(DTO as any, OPERATOR)).resolves.toBeDefined();
    });
  });
});

describe("InlineReturnsQuoteService.quote: the additive refund fields (SA-727)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let quote: InlineReturnsQuoteService;
  const chunk = (id: string | null) => ({
    sourceOrderId: id ? "o1" : null,
    sourceInvoiceItemId: id,
    sourceOrderItemId: null,
    productId: "p1",
    pieces: 1,
    subtotal: 10,
    taxAmount: 0,
    categoryTax: 0,
    priceSource: "SOURCE_INVOICE",
    unitPrice: 10,
  });

  beforeEach(() => {
    prisma = createMockPrisma();
    quote = new InlineReturnsQuoteService(prisma as any, {} as SystemConfigService);
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: true });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "ii-1", invoiceId: "inv-1" }]);
    prisma.invoice.findMany.mockResolvedValue([
      paidInvoice({
        payments: [
          { amount: 20, status: "PAID", method: "CREDIT_CARD" },
          { amount: 10, status: "PAID", method: "CASH" },
          { amount: 5, status: "VOID", method: "CHECK" },
        ],
        total: 30,
      }),
    ]);
  });
  const priced = (chunks: any[]) =>
    jest.spyOn(quote, "priceInlineReturn").mockResolvedValue({
      chunks,
      subtotal: 10,
      taxAmount: 0,
      categoryTax: 0,
      total: 10,
      productBreakdown: {},
    } as any);
  const dto = { customerId: "c1", items: [{ productId: "p1", boxes: 0, pieces: 1 }] } as any;

  it("a fully paid walk-in sale: canRefund = true, paidInFull = true, paidMethods = the CONFIRMED methods, customerIsWalkIn = true", async () => {
    priced([chunk("ii-1")]);
    expect(await quote.quote(dto, OPERATOR)).toMatchObject({
      canRefund: true,
      paidInFull: true,
      paidMethods: ["CASH", "CREDIT_CARD"],
      customerIsWalkIn: true,
    });
  });

  it("canRefund is ALWAYS an explicit boolean: false for an unpaid sale, false for a caller without the gate, false with an unreferenced line", async () => {
    priced([chunk("ii-1")]);
    prisma.invoice.findMany.mockResolvedValue([paidInvoice({ payments: [] })]);
    const unpaid = await quote.quote(dto, OPERATOR);
    expect(unpaid.canRefund).toBe(false);
    expect(unpaid.paidInFull).toBe(false);

    prisma.invoice.findMany.mockResolvedValue([paidInvoice()]);
    const driver = await quote.quote({ ...dto, routeRunStopId: "s" }, DRIVER);
    expect(driver.canRefund).toBe(false);
    expect(driver.paidInFull).toBe(true); // a fact about the invoices, not the caller

    priced([chunk("ii-1"), chunk(null)]);
    expect((await quote.quote(dto, OPERATOR)).canRefund).toBe(false);
  });

  it("a customer who is not the walk-in: customerIsWalkIn = false (an ordinary customer, NULL or false column)", async () => {
    priced([chunk("ii-1")]);
    prisma.customer.findFirst.mockResolvedValue({ isWalkIn: null });
    expect((await quote.quote(dto, OPERATOR)).customerIsWalkIn).toBe(false);
  });

  it("the refund amount IS the quote's credit total: the one server computation, no second formula", async () => {
    priced([chunk("ii-1")]);
    const q = await quote.quote(dto, OPERATOR);
    expect(
      inlineReturnAmount({
        creditSubtotal: q.subtotal,
        creditTax: q.taxAmount,
        creditCategoryTax: q.categoryTax,
      }),
    ).toBe(q.total);
  });
});

describe("refund gate + pending marker helpers", () => {
  it("canRefundRole mirrors RolesGuard's OPERATOR requirement: OPERATOR, TENANT_ADMIN and SUPER_ADMIN only", () => {
    expect(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"].every(canRefundRole)).toBe(true);
    expect(["DRIVER", "CUSTOMER", "", null, undefined].some((r) => canRefundRole(r as any))).toBe(
      false,
    );
  });
  it("isRefundPending: RECEIVED INLINE, no resolution, no hold", () => {
    expect(isRefundPending(receivedReturn())).toBe(true);
    expect(isRefundPending(receivedReturn({ refundedAt: new Date() }))).toBe(false);
    expect(isRefundPending(receivedReturn({ refundMethod: null }))).toBe(false);
    expect(isRefundPending(receivedReturn({ creditNoteId: "cn" }))).toBe(false);
    expect(
      isRefundPending(receivedReturn({ status: "REFUNDED", refundMethod: "EXTERNAL_REFUND" })),
    ).toBe(false);
    expect(isRefundPending(receivedReturn({ kind: "STANDARD" }))).toBe(false);
  });
});
