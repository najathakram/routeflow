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
import {
  canRefundRole,
  inlineReturnAmount,
  isRefundPending,
  loadSourceInvoicesState,
  sourcesAreRefundable,
} from "./inline-return-refund";
import { inlineReturnItemsFingerprint, replayItemsMatch } from "./inline-return-fingerprint";
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
  let rawValues: unknown[][];
  let creditNotes: { mintStandaloneInTx: jest.Mock; settleOrderCreditsInTx: jest.Mock };
  let quoteService: { priceInlineReturn: jest.Mock };
  let addonService: { hasAddon: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    row = receivedReturn();
    rawCalls = [];
    rawValues = [];
    // one tx client for every transaction: records the raw lock statements (and their bound values) in order
    prisma.tenantTransaction.mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
          rawCalls.push(strings.join("?").replace(/\s+/g, " ").trim());
          rawValues.push(values);
          return Promise.resolve(0);
        }),
      }),
    );
    prisma.return.findFirst.mockImplementation(async () => ({ ...row }));
    prisma.return.findUnique.mockImplementation(async () => ({ ...row }));
    prisma.return.updateMany.mockResolvedValue({ count: 1 });
    prisma.invoiceItem.findMany.mockResolvedValue([{ id: "invitem-1", invoiceId: "inv-1" }]);
    prisma.invoice.findMany.mockResolvedValue([paidInvoice()]);
    // SA-749r2 item 9: the cash applied to the source sale (the cap reads it under the locks): $30 in cash on src-order-1
    prisma.invoicePayment.findMany.mockResolvedValue([
      { amount: 30, invoice: { orderId: "src-order-1" } },
    ]);
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
      data: {
        status: "REFUNDED",
        refundAmount: 30,
        refundedAt: expect.any(Date),
        refundTender: "CASH", // SA-740r: the tender is written in the SAME CAS as refundedAt
      },
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

  it("M5: ONE awaited audit row {returnId, invoiceIds, amount, tender, actor, impersonatedBy}; the row carries the tender as its PaymentMethod column too", async () => {
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
    // refundMethod stays the literal stored at capture: no new string. The tender is the PaymentMethod column (SA-740r):
    // a CARD refund is stored as CREDIT_CARD, the same map the counter payment legs use.
    const data = prisma.return.updateMany.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("refundMethod");
    expect(data.refundTender).toBe("CREDIT_CARD");
  });

  describe("SA-740r: Return.refundTender is the tender of record", () => {
    const refundedRow = (over: Record<string, unknown> = {}) =>
      receivedReturn({
        status: "REFUNDED",
        refundMethod: "EXTERNAL_REFUND",
        refundAmount: 30,
        refundedAt: new Date(),
        ...over,
      });

    it("CHECK is stored as CHECK, CARD as CREDIT_CARD, CASH as CASH, in the claim itself", async () => {
      for (const [tender, column] of [
        ["CASH", "CASH"],
        ["CARD", "CREDIT_CARD"],
        ["CHECK", "CHECK"],
      ] as const) {
        prisma.return.updateMany.mockClear();
        row = receivedReturn();
        await service.refund("ret-1", { ...REFUND, tender }, OPERATOR);
        expect(prisma.return.updateMany.mock.calls[0][0].data.refundTender).toBe(column);
      }
    });

    it("a replay trusts the COLUMN: the same tender (CARD vs CREDIT_CARD) is a 200 with no audit row read needed", async () => {
      row = refundedRow({ refundTender: "CREDIT_CARD" });
      prisma.auditLog.findFirst.mockResolvedValue(null);
      const out = await service.refund("ret-1", { ...REFUND, tender: "CARD" }, OPERATOR);
      expect(out).toMatchObject({ status: "REFUNDED", refundTender: "CARD" });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("a replay with another tender than the column is 409 even when the audit row says otherwise", async () => {
      row = refundedRow({ refundTender: "CREDIT_CARD" });
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CASH" } });
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "RETURN_ALREADY_RESOLVED",
      );
    });

    it("a row the backfill has not reached (column null) still replays from the audit tender", async () => {
      row = refundedRow({ refundTender: null });
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CASH", amount: 30 } });
      await expect(service.refund("ret-1", REFUND, OPERATOR)).resolves.toMatchObject({
        refundTender: "CASH",
      });
    });

    it("the response names the tender in the counter vocabulary read back from the stored column", async () => {
      row = refundedRow({ refundTender: "CHECK" });
      const out = await service.refund("ret-1", { ...REFUND, tender: "CHECK" }, OPERATOR);
      expect(out.refundTender).toBe("CHECK");
    });
  });

  it("M5 (rollback): an audit failure rejects the whole refund, after the claim ran inside the same transaction", async () => {
    prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
    await expect(service.refund("ret-1", REFUND, OPERATOR)).rejects.toThrow("audit down");
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1); // claim + audit share ONE tx: the DB spec proves the rollback
  });

  it("lock order: Return, then the carrying + source Orders in one id-ordered statement, then the source Invoices id-sorted", async () => {
    await service.refund("ret-1", REFUND, OPERATOR);
    expect(rawCalls).toHaveLength(3);
    expect(rawCalls[0]).toMatch(/FROM "Return" WHERE id = \? AND .* FOR UPDATE/);
    expect(rawCalls[1]).toMatch(/FROM "Order" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/);
    expect(rawCalls[2]).toMatch(/FROM "Invoice" WHERE id IN \(.*\).*ORDER BY id FOR UPDATE/);
  });

  describe("SA-749r2 item 9: a CASH refund may not exceed the cash applied to the sale minus earlier cash refunds", () => {
    it("cash applied 20 of a 30.00 return: a CASH refund is 409 REFUND_EXCEEDS_CASH_PAID carrying the maximum, nothing written", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 20, invoice: { orderId: "src-order-1" } },
      ]);
      const err: any = await service.refund("ret-1", REFUND, OPERATOR).catch((e) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 20,
        requested: 30,
      });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("N3: a COUNTER order with the tender somehow absent is capped as cash (counterOrder is passed)", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey: null });
      prisma.invoicePayment.findMany.mockResolvedValue([
        { amount: 10, invoice: { orderId: "src-order-1" } },
      ]);
      const err: any = await service
        .refund("ret-1", { expectedAmount: 30 } as any, OPERATOR)
        .catch((e) => e);
      expect(err.getResponse()).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 10,
      });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("the same refund by CARD or CHECK is not capped (card and check limits wait for their own reports)", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      for (const tender of ["CARD", "CHECK"]) {
        prisma.return.updateMany.mockClear();
        row = receivedReturn();
        await expect(
          service.refund("ret-1", { ...REFUND, tender }, OPERATOR),
        ).resolves.toBeDefined();
        expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
      }
    });

    it("an earlier cash refund of 12.00 on the sale leaves 18.00: a 30.00 cash refund is refused", async () => {
      prisma.returnItem.findMany.mockResolvedValue([
        { sourceOrderId: "src-order-1", subtotal: 12, taxAmount: 0, categoryTax: 0 },
      ]);
      const err: any = await service.refund("ret-1", REFUND, OPERATOR).catch((e) => e);
      expect(err.getResponse()).toMatchObject({
        code: "REFUND_EXCEEDS_CASH_PAID",
        maxCashRefund: 18,
      });
    });

    it("the cap runs under the order and invoice locks, before the claim", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      await service.refund("ret-1", REFUND, OPERATOR).catch(() => undefined);
      expect(rawCalls).toHaveLength(3); // Return, Orders, Invoices all taken before the refusal
      expect(prisma.invoicePayment.findMany.mock.invocationCallOrder[0]).toBeGreaterThan(0);
    });
  });

  describe("SA-758 CR-2: refundedAt is the DATABASE clock, read after the close lock", () => {
    it("the claim stamps refundedAt with clock_timestamp() of the transaction, after the lock and before the claim", async () => {
      const dbTime = new Date("2026-10-08T20:00:00.123Z");
      prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey: null });
      const q = jest.fn().mockResolvedValue([{ now: dbTime }]);
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...prisma,
          $queryRaw: q,
          $executeRaw: jest.fn((strings: TemplateStringsArray, ...values: unknown[]) => {
            rawCalls.push(strings.join("?").replace(/\s+/g, " ").trim());
            rawValues.push(values);
            return Promise.resolve(0);
          }),
        }),
      );
      await service.refund("ret-1", REFUND, OPERATOR);
      expect(prisma.return.updateMany.mock.calls[0][0].data.refundedAt).toEqual(dbTime);
      expect(rawCalls[0]).toMatch(/pg_advisory_xact_lock_shared/);
      expect(q).toHaveBeenCalledTimes(1);
    });
  });

  describe("SA-740r2 item 6: the shared counter-close lock is the FIRST statement for a counter order", () => {
    it("counter order: counter-close, then Return, Orders, Invoices; the key is tenant:register (Order.registerKey ?? main)", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey: null });
      await service.refund("ret-1", REFUND, OPERATOR);
      expect(rawCalls).toHaveLength(4);
      expect(rawCalls[0]).toBe(
        "SELECT pg_advisory_xact_lock_shared(hashtext('counter-close'), hashtext(?))",
      );
      expect(rawValues[0]).toEqual(["test-tenant:main"]);
      expect(rawCalls[1]).toMatch(/FROM "Return" WHERE id = \? AND .* FOR UPDATE/);
      expect(rawCalls[2]).toMatch(/FROM "Order" WHERE id IN/);
      expect(rawCalls[3]).toMatch(/FROM "Invoice" WHERE id IN/);
      // the register is read from the CARRYING order, tenant-scoped
      expect(prisma.order.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: "ord-carrying" } }),
      );
    });

    it("a named register is keyed as tenant:register", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: true, registerKey: "till-2" });
      await service.refund("ret-1", REFUND, OPERATOR);
      expect(rawValues[0]).toEqual(["test-tenant:till-2"]);
    });

    it("a non-counter order takes no close lock (its refund is not a till event)", async () => {
      prisma.order.findFirst.mockResolvedValue({ counterSale: false, registerKey: null });
      await service.refund("ret-1", REFUND, OPERATOR);
      expect(rawCalls).toHaveLength(3);
      expect(rawCalls.some((c) => c.includes("counter-close"))).toBe(false);
    });
  });

  it("F7: the Return FOR UPDATE carries an explicit, BOUND tenant predicate (never string-built SQL)", async () => {
    await service.refund("ret-1", REFUND, OPERATOR);
    expect(rawCalls[0]).toBe(
      'SELECT id FROM "Return" WHERE id = ? AND (?::text IS NULL OR "tenantId" = ?) FOR UPDATE',
    );
    // the id and the tenant (twice: the null-tolerant test and the equality) are parameters, in order
    expect(rawValues[0]).toEqual(["ret-1", expect.anything(), expect.anything()]);
    expect(rawValues[0][1]).toBe(rawValues[0][2]);
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

  describe("F4: store credit is never turned into cash", () => {
    it.each(["CREDIT_NOTE", "ADVANCE"])(
      "an invoice paid (even in part) with a %s payment is 409 REFUND_PAID_WITH_STORE_CREDIT: nothing claimed, no audit row",
      async (method) => {
        prisma.invoice.findMany.mockResolvedValue([
          paidInvoice({
            payments: [
              { amount: 10, status: "PAID", method: "CASH" },
              { amount: 20, status: "PAID", method },
            ],
          }),
        ]);
        const err: any = await service.refund("ret-1", REFUND, OPERATOR).catch((e) => e);
        expect(err.getStatus()).toBe(409);
        expect(err.getResponse()).toMatchObject({ code: "REFUND_PAID_WITH_STORE_CREDIT" });
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      },
    );

    it("EVERY money tender still refunds: CASH, CHECK, CREDIT_CARD, ACH, ZELLE and OTHER", async () => {
      for (const method of ["CASH", "CHECK", "CREDIT_CARD", "ACH", "ZELLE", "OTHER"]) {
        prisma.invoice.findMany.mockResolvedValue([
          paidInvoice({ payments: [{ amount: 30, status: "PAID", method }] }),
        ]);
        await expect(service.refund("ret-1", REFUND, OPERATOR)).resolves.toMatchObject({
          refundTender: "CASH",
        });
      }
    });

    it("a store-credit payment that is not CONFIRMED (VOID) does not block a cash refund", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({
          payments: [
            { amount: 30, status: "PAID", method: "CASH" },
            { amount: 5, status: "VOID", method: "CREDIT_NOTE" },
          ],
        }),
      ]);
      await expect(service.refund("ret-1", REFUND, OPERATOR)).resolves.toBeDefined();
    });

    it("one store-credit-paid invoice among several blocks the whole refund", async () => {
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
        paidInvoice({ id: "inv-2", payments: [{ amount: 30, status: "PAID", method: "ADVANCE" }] }),
      ]);
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "REFUND_PAID_WITH_STORE_CREDIT",
      );
    });

    it("an invoice still owing wins: REFUND_NEEDS_PAID_INVOICE is reported before the store-credit refusal", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({ payments: [{ amount: 10, status: "PAID", method: "CREDIT_NOTE" }] }),
      ]);
      expect(await codeOf(service.refund("ret-1", REFUND, OPERATOR))).toBe(
        "REFUND_NEEDS_PAID_INVOICE",
      );
    });
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
      (creditNotes as any).cancelLockSet = jest
        .fn()
        .mockResolvedValue({ orderIds: [], invoiceIds: [] });
      await service.cancel("ret-1", OPERATOR);
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
    });
  });

  describe("store credit instead (SA-727b)", () => {
    beforeEach(() => {
      creditNotes.mintStandaloneInTx.mockResolvedValue({
        id: "cn-1",
        creditNoteNumber: "CN-1",
        customerId: "cust-1",
        amount: 30,
      });
    });

    it("converts a PENDING refund in ONE tx: Return/Order/Invoice locks, the CAS clears the stored intent, the credit is minted and linked, an awaited audit row {from, to}", async () => {
      const out = await service.storeCreditInstead("ret-1", OPERATOR);
      expect(out).toBeDefined();
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
      // F7: the explicit bound tenant predicate on the conversion's Return lock too
      expect(rawCalls[0]).toBe(
        'SELECT id FROM "Return" WHERE id = ? AND (?::text IS NULL OR "tenantId" = ?) FOR UPDATE',
      );
      expect(rawValues[0]).toEqual(["ret-1", expect.anything(), expect.anything()]);
      expect(rawCalls[1]).toMatch(/FROM "Order" WHERE id IN/);
      expect(rawCalls[2]).toMatch(/FROM "Invoice" WHERE id IN/);
      // CAS first (clears the intent), then the credit mint's own link CAS (which needs refundMethod null)
      expect(prisma.return.updateMany.mock.calls[0][0]).toEqual({
        where: {
          id: "ret-1",
          kind: "INLINE",
          status: "RECEIVED",
          creditNoteId: null,
          refundMethod: "EXTERNAL_REFUND",
          refundedAt: null,
        },
        data: { refundMethod: null },
      });
      expect(creditNotes.mintStandaloneInTx).toHaveBeenCalledTimes(1);
      expect(creditNotes.mintStandaloneInTx.mock.calls[0][1]).toMatchObject({
        customerId: "cust-1",
        amount: 30,
      });
      expect(prisma.return.updateMany.mock.calls[1][0]).toMatchObject({
        where: { id: "ret-1", status: "RECEIVED", creditNoteId: null, refundMethod: null },
        data: { creditNoteId: "cn-1", status: "REFUNDED", refundMethod: "CREDIT_NOTE" },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1);
      expect(prisma.auditLog.create.mock.calls[0][0].data).toMatchObject({
        action: "inline_return.store_credit_instead",
        entityType: "Return",
        entityId: "ret-1",
        meta: expect.objectContaining({
          from: "REFUND_PENDING",
          to: "STORE_CREDIT",
          amount: 30,
          creditNoteId: "cn-1",
          actor: "user-OPERATOR",
        }),
      });
    });

    it("SA-773 N4: a source invoice voided or written off since the capture is refused 409 RETURN_NOTHING_BILLED before the CAS and the mint", async () => {
      prisma.invoice.findFirst.mockResolvedValue({ id: "inv-1" });
      const err: any = await service.storeCreditInstead("ret-1", OPERATOR).catch((e: any) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: "RETURN_NOTHING_BILLED",
        invoiceId: "inv-1",
      });
      expect(prisma.invoice.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ["inv-1"] }, status: { in: ["VOID", "WRITTEN_OFF"] } },
        }),
      );
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("SA-773 N4: a source line that no longer exists is refused 409 RETURN_NOTHING_BILLED the same way (an item with no pool is never minted unchecked)", async () => {
      prisma.invoiceItem.findMany.mockResolvedValue([]);
      const err: any = await service.storeCreditInstead("ret-1", OPERATOR).catch((e: any) => e);
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: "RETURN_NOTHING_BILLED" });
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    describe("F3: a retry of an already-converted return is a 200 (the same as a refund replay)", () => {
      const converted = (over: Record<string, unknown> = {}) =>
        receivedReturn({
          status: "REFUNDED",
          refundMethod: "CREDIT_NOTE",
          creditNoteId: "cn-1",
          ...over,
        });

      it("REFUNDED via CREDIT_NOTE with an inline_return.store_credit_instead audit row: 200 with the row, no transaction, no second mint, no second audit row", async () => {
        row = converted();
        prisma.auditLog.findFirst.mockResolvedValue({ id: "audit-1" });
        const out = await service.storeCreditInstead("ret-1", OPERATOR);
        expect(out).toMatchObject({ id: "ret-1", status: "REFUNDED", creditNoteId: "cn-1" });
        expect(prisma.auditLog.findFirst).toHaveBeenCalledWith({
          where: {
            action: "inline_return.store_credit_instead",
            entityType: "Return",
            entityId: "ret-1",
          },
          select: { id: true },
        });
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
      });

      it("a racer converted it while this call waited for the lock: the in-tx re-check is the same 200, still nothing minted or written", async () => {
        row = converted(); // what the in-lock re-read (and the read-back) sees: the racer's conversion
        prisma.return.findFirst.mockResolvedValueOnce(receivedReturn()); // the unlocked pre-read still sees it pending
        prisma.auditLog.findFirst.mockResolvedValue({ id: "audit-1" });
        const out = await service.storeCreditInstead("ret-1", OPERATOR);
        expect(out).toMatchObject({ status: "REFUNDED", creditNoteId: "cn-1" });
        expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
        expect(prisma.return.updateMany).not.toHaveBeenCalled();
        expect(prisma.auditLog.create).not.toHaveBeenCalled();
      });

      it("a return resolved SOME OTHER WAY still refuses 409 RETURN_ALREADY_RESOLVED: a plain credit with no conversion audit row, a recorded refund", async () => {
        prisma.auditLog.findFirst.mockResolvedValue(null);
        for (const over of [
          converted(), // credit note, but no store_credit_instead audit row (credited at capture)
          receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 }), // a recorded refund
          converted({ refundMethod: "EXTERNAL_REFUND" }), // not the conversion's shape
        ]) {
          row = over;
          expect(await codeOf(service.storeCreditInstead("ret-1", OPERATOR))).toBe(
            "RETURN_ALREADY_RESOLVED",
          );
        }
        // and a refund row never asks for the audit row at all (only CREDIT_NOTE-resolved rows can be conversions)
        row = receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 });
        prisma.auditLog.findFirst.mockClear();
        await codeOf(service.storeCreditInstead("ret-1", OPERATOR));
        expect(prisma.auditLog.findFirst).not.toHaveBeenCalled();
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      });
    });

    it("the CAS loser (a refund won the race) is 409 RETURN_ALREADY_RESOLVED: nothing minted, no audit row", async () => {
      prisma.return.updateMany.mockResolvedValueOnce({ count: 0 });
      expect(await codeOf(service.storeCreditInstead("ret-1", OPERATOR))).toBe(
        "RETURN_ALREADY_RESOLVED",
      );
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("a REFUNDED (or already credited) return is 409 RETURN_ALREADY_RESOLVED without opening a transaction", async () => {
      for (const resolved of [
        { status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 },
        { status: "REFUNDED", refundMethod: "CREDIT_NOTE", creditNoteId: "cn-9" },
      ]) {
        row = receivedReturn(resolved);
        expect(await codeOf(service.storeCreditInstead("ret-1", OPERATOR))).toBe(
          "RETURN_ALREADY_RESOLVED",
        );
      }
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
    });

    it("only a PENDING refund converts: a store-credit RECEIVED row, a cancelled one and a $0 one are 409 RETURN_NOT_REFUNDABLE", async () => {
      for (const over of [
        { refundMethod: null },
        { status: "CANCELLED" },
        { creditSubtotal: 0, creditTax: 0 },
      ]) {
        row = receivedReturn(over);
        expect(await codeOf(service.storeCreditInstead("ret-1", OPERATOR))).toBe(
          "RETURN_NOT_REFUNDABLE",
        );
      }
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });

    it("an audit failure rejects the whole conversion (one transaction: the DB spec proves the rollback of the cleared intent)", async () => {
      prisma.auditLog.create.mockRejectedValue(new Error("audit down"));
      await expect(service.storeCreditInstead("ret-1", OPERATOR)).rejects.toThrow("audit down");
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    });

    it("only office roles convert: a DRIVER is 403 with a {code} body before any read", async () => {
      const err: any = await service.storeCreditInstead("ret-1", DRIVER).catch((e) => e);
      expect(err.getStatus()).toBe(403);
      expect(err.getResponse()).toMatchObject({ code: "REFUND_NOT_ALLOWED" });
      expect(prisma.return.findFirst).not.toHaveBeenCalled();
    });

    it("the automatic path never converts: issueCredit leaves a pending refund alone (refundMethod IS NULL guard kept)", async () => {
      prisma.return.findFirst.mockImplementation(async () => receivedReturn());
      await (service as any).issueCredit("ret-1");
      expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      expect(prisma.return.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("the contract the web depends on (#3295): coded bodies, statuses, idempotency", () => {
    const body = async (p: Promise<unknown>) => {
      const e: any = await p.catch((x) => x);
      return { status: e.getStatus?.(), body: e.getResponse?.() };
    };

    it("each refusal is a 409 whose body carries {code}", async () => {
      // REFUND_AMOUNT_CHANGED (also carries the real amount)
      let r = await body(service.refund("ret-1", { ...REFUND, expectedAmount: 31 }, OPERATOR));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "REFUND_AMOUNT_CHANGED", amount: 30 });
      // REFUND_NEEDS_PAID_INVOICE
      prisma.invoice.findMany.mockResolvedValue([paidInvoice({ payments: [] })]);
      r = await body(service.refund("ret-1", REFUND, OPERATOR));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "REFUND_NEEDS_PAID_INVOICE" });
      // RETURN_NOT_REFUNDABLE
      row = receivedReturn({ status: "CANCELLED" });
      r = await body(service.refund("ret-1", REFUND, OPERATOR));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "RETURN_NOT_REFUNDABLE" });
      // RETURN_ALREADY_RESOLVED
      row = receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 });
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CARD" } });
      r = await body(service.refund("ret-1", REFUND, OPERATOR));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "RETURN_ALREADY_RESOLVED" });
      // RETURN_REFUNDED_CASH (cancel)
      row = receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 });
      r = await body(service.cancel("ret-1", OPERATOR));
      expect(r.status).toBe(409);
      expect(r.body).toMatchObject({ code: "RETURN_REFUNDED_CASH" });
    });

    it("the 403 of the service-level gate carries {code: REFUND_NOT_ALLOWED}", async () => {
      const r = await body(service.refund("ret-1", REFUND, DRIVER));
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ code: "REFUND_NOT_ALLOWED" });
    });

    it("idempotent: the SAME tender and amount again is a 200 with the stored result and NEVER a second refund (SA-727a); another tender or amount is 409 RETURN_ALREADY_RESOLVED", async () => {
      await service.refund("ret-1", REFUND, OPERATOR); // the first POST records it
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1);
      row = receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 });
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CASH", amount: 30 } });
      const second = await service.refund("ret-1", REFUND, OPERATOR);
      expect(second).toMatchObject({ status: "REFUNDED", refundTender: "CASH" });
      expect(prisma.return.updateMany).toHaveBeenCalledTimes(1); // no second write
      expect(prisma.auditLog.create).toHaveBeenCalledTimes(1); // no second audit row
      expect(
        (await body(service.refund("ret-1", { ...REFUND, tender: "CHECK" }, OPERATOR))).body,
      ).toMatchObject({
        code: "RETURN_ALREADY_RESOLVED",
      });
    });

    it("expectedAmount is compared with the SERVER-computed amount at refund time (a pending refund stores refundAmount null); a replay compares with the STORED refundAmount", async () => {
      row = receivedReturn(); // pending: refundAmount null
      expect(row.refundAmount).toBeNull();
      await expect(service.refund("ret-1", REFUND, OPERATOR)).resolves.toBeDefined(); // 30 = 28 + 2
      row = receivedReturn({ status: "REFUNDED", refundedAt: new Date(), refundAmount: 30 });
      prisma.auditLog.findFirst.mockResolvedValue({ meta: { tender: "CASH" } });
      expect(
        (await body(service.refund("ret-1", { ...REFUND, expectedAmount: 29 }, OPERATOR))).body,
      ).toMatchObject({
        code: "RETURN_ALREADY_RESOLVED",
      });
    });

    it("an OPERATOR and a TENANT_ADMIN may capture-for-refund and refund", async () => {
      for (const u of [OPERATOR, user("TENANT_ADMIN")]) {
        row = receivedReturn();
        await expect(service.refund("ret-1", REFUND, u)).resolves.toMatchObject({
          refundTender: "CASH",
        });
      }
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

    describe("F6: the capture's resolution is part of the replay fingerprint", () => {
      it("a REFUND capture stores resolution REFUND in capturePayload; a STORE_CREDIT capture stores no such key (every old payload is unchanged)", async () => {
        await service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR);
        expect(prisma.return.create.mock.calls[0][0].data.capturePayload).toMatchObject({
          v: 1,
          resolution: "REFUND",
        });
        prisma.return.create.mockClear();
        await service.capture(DTO as any, OPERATOR);
        const payload = prisma.return.create.mock.calls[0][0].data.capturePayload;
        expect(payload).not.toHaveProperty("resolution");
        expect(payload).toEqual(inlineReturnItemsFingerprint(DTO.items, undefined));
      });

      it("the same key replayed with a DIFFERENT resolution is 409 INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS, both ways; nothing minted or created", async () => {
        const stored = (resolution?: string) => ({
          ...receivedReturn({ refundMethod: resolution === "REFUND" ? "EXTERNAL_REFUND" : null }),
          capturePayload: inlineReturnItemsFingerprint(DTO.items, undefined, resolution),
        });
        // stored REFUND, replayed as the default (and as an explicit STORE_CREDIT)
        prisma.return.findFirst.mockImplementation(async () => stored("REFUND"));
        expect(await codeOf(service.capture(DTO as any, OPERATOR))).toBe(
          "INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS",
        );
        expect(
          await codeOf(service.capture({ ...DTO, resolution: "STORE_CREDIT" } as any, OPERATOR)),
        ).toBe("INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS");
        // stored STORE_CREDIT, replayed as REFUND
        prisma.return.findFirst.mockImplementation(async () => stored());
        expect(
          await codeOf(service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR)),
        ).toBe("INLINE_RETURN_KEY_REUSED_WITH_DIFFERENT_ITEMS");
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
        expect(prisma.return.create).not.toHaveBeenCalled();
      });

      it("the IDENTICAL resolution still replays (a REFUND capture replayed as REFUND answers 200 refundPending)", async () => {
        prisma.return.findFirst.mockImplementation(async () => ({
          ...receivedReturn(),
          items: [{ productId: "prod-1", qty: 6, restock: true }],
          capturePayload: inlineReturnItemsFingerprint(DTO.items, undefined, "REFUND"),
        }));
        const out = await service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR);
        expect(out).toMatchObject({ id: "ret-1", refundPending: true });
        expect(prisma.return.create).not.toHaveBeenCalled();
        expect(creditNotes.mintStandaloneInTx).not.toHaveBeenCalled();
      });

      it("replayItemsMatch (pure): an absent stored resolution reads as STORE_CREDIT; REFUND vs STORE_CREDIT is a mismatch both ways; a legacy row (no payload) stays legacy", () => {
        const items = DTO.items;
        const refundPayload = inlineReturnItemsFingerprint(items, undefined, "REFUND");
        const creditPayload = inlineReturnItemsFingerprint(items, undefined, "STORE_CREDIT");
        expect(creditPayload).not.toHaveProperty("resolution");
        expect(replayItemsMatch(creditPayload, items, undefined, undefined)).toBe("match");
        expect(replayItemsMatch(creditPayload, items, undefined, "STORE_CREDIT")).toBe("match");
        expect(replayItemsMatch(creditPayload, items, undefined, "REFUND")).toBe("mismatch");
        expect(replayItemsMatch(refundPayload, items, undefined, "REFUND")).toBe("match");
        expect(replayItemsMatch(refundPayload, items, undefined, undefined)).toBe("mismatch");
        expect(replayItemsMatch(refundPayload, items, undefined, "STORE_CREDIT")).toBe("mismatch");
        expect(replayItemsMatch(null, items, undefined, "REFUND")).toBe("legacy");
      });
    });

    it("F4: a REFUND capture of goods paid (even in part) with store credit is refused 409 REFUND_PAID_WITH_STORE_CREDIT BEFORE any write", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({
          payments: [
            { amount: 10, status: "PAID", method: "CASH" },
            { amount: 20, status: "PAID", method: "CREDIT_NOTE" },
          ],
        }),
      ]);
      expect(await codeOf(service.capture({ ...DTO, resolution: "REFUND" } as any, OPERATOR))).toBe(
        "REFUND_PAID_WITH_STORE_CREDIT",
      );
      expect(prisma.return.create).not.toHaveBeenCalled();
      expect(prisma.stockMovement.create).not.toHaveBeenCalled();
    });

    it("F4: a STORE_CREDIT capture is unaffected by how the invoice was paid", async () => {
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({ payments: [{ amount: 30, status: "PAID", method: "ADVANCE" }] }),
      ]);
      await expect(service.capture(DTO as any, OPERATOR)).resolves.toBeDefined();
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
      paidWithStoreCredit: false,
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

  it("F4: any part paid with store credit (a CONFIRMED CREDIT_NOTE or ADVANCE payment): paidWithStoreCredit = true and canRefund = false, while paidInFull stays the fact about the invoices", async () => {
    priced([chunk("ii-1")]);
    for (const method of ["CREDIT_NOTE", "ADVANCE"]) {
      prisma.invoice.findMany.mockResolvedValue([
        paidInvoice({
          payments: [
            { amount: 10, status: "PAID", method: "CASH" },
            { amount: 20, status: "PAID", method },
          ],
        }),
      ]);
      expect(await quote.quote(dto, OPERATOR)).toMatchObject({
        canRefund: false,
        paidInFull: true,
        paidWithStoreCredit: true,
        paidMethods: ["CASH", method].sort(),
      });
    }
  });

  it("F4: a money-only sale, and a store-credit payment that is VOID/PENDING, report paidWithStoreCredit = false and stay refundable", async () => {
    priced([chunk("ii-1")]);
    expect(await quote.quote(dto, OPERATOR)).toMatchObject({
      canRefund: true,
      paidWithStoreCredit: false,
    });
    prisma.invoice.findMany.mockResolvedValue([
      paidInvoice({
        payments: [
          { amount: 30, status: "PAID", method: "ZELLE" },
          { amount: 5, status: "VOID", method: "CREDIT_NOTE" },
          { amount: 5, status: "PENDING", method: "ADVANCE" },
        ],
      }),
    ]);
    expect(await quote.quote(dto, OPERATOR)).toMatchObject({
      canRefund: true,
      paidWithStoreCredit: false,
    });
  });

  it("F4: paidWithStoreCredit is a fact about the invoices, not the caller: a DRIVER still sees it (canRefund false either way)", async () => {
    priced([chunk("ii-1")]);
    prisma.invoice.findMany.mockResolvedValue([
      paidInvoice({ payments: [{ amount: 30, status: "PAID", method: "CREDIT_NOTE" }] }),
    ]);
    const driver = await quote.quote({ ...dto, routeRunStopId: "s" }, DRIVER);
    expect(driver).toMatchObject({ canRefund: false, paidWithStoreCredit: true });
  });

  it("F5: canRefund requires a return worth money: a paid sale with a $0.00 (or sub-cent) total is not refundable, whoever asks", async () => {
    for (const total of [0, 0.001, 0.0005]) {
      jest.spyOn(quote, "priceInlineReturn").mockResolvedValue({
        chunks: [chunk("ii-1")],
        subtotal: total,
        taxAmount: 0,
        categoryTax: 0,
        total,
        productBreakdown: {},
      } as any);
      const out = await quote.quote(dto, OPERATOR);
      expect(out.canRefund).toBe(false);
      expect(out.paidInFull).toBe(true); // still a fact about the invoices
    }
    // one cent is worth money
    jest.spyOn(quote, "priceInlineReturn").mockResolvedValue({
      chunks: [chunk("ii-1")],
      subtotal: 0.01,
      taxAmount: 0,
      categoryTax: 0,
      total: 0.01,
      productBreakdown: {},
    } as any);
    expect((await quote.quote(dto, OPERATOR)).canRefund).toBe(true);
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

describe("loadSourceInvoicesState + sourcesAreRefundable (F4, pure over a mocked client)", () => {
  const db = (payments: any[], over: Record<string, unknown> = {}) => ({
    invoiceItem: { findMany: jest.fn().mockResolvedValue([{ id: "ii-1", invoiceId: "inv-1" }]) },
    invoice: { findMany: jest.fn().mockResolvedValue([paidInvoice({ payments, ...over })]) },
  });

  it.each([
    ["CASH", false],
    ["CHECK", false],
    ["CREDIT_CARD", false],
    ["ACH", false],
    ["ZELLE", false],
    ["OTHER", false],
    ["CREDIT_NOTE", true],
    ["ADVANCE", true],
  ])("a confirmed %s payment: paidWithStoreCredit = %s", async (method, expected) => {
    const s = await loadSourceInvoicesState(db([{ amount: 30, status: "PAID", method }]), [
      { sourceInvoiceItemId: "ii-1" },
    ]);
    expect(s.paidInFull).toBe(true);
    expect(s.paidWithStoreCredit).toBe(expected);
    expect(sourcesAreRefundable(s)).toBe(!expected);
  });

  it("only a CONFIRMED, non-zero store-credit payment counts (PENDING, VOID and $0.00 do not)", async () => {
    const s = await loadSourceInvoicesState(
      db([
        { amount: 30, status: "PAID", method: "CASH" },
        { amount: 5, status: "PENDING", method: "CREDIT_NOTE" },
        { amount: 5, status: "VOID", method: "ADVANCE" },
        { amount: 0, status: "PAID", method: "CREDIT_NOTE" },
      ]),
      [{ sourceInvoiceItemId: "ii-1" }],
    );
    expect(s.paidWithStoreCredit).toBe(false);
    expect(sourcesAreRefundable(s)).toBe(true);
  });

  it("the early exits (no lines, no invoices) fail closed with paidWithStoreCredit = false", async () => {
    expect(await loadSourceInvoicesState(db([]), [])).toEqual({
      invoiceIds: [],
      paidInFull: false,
      paidMethods: [],
      paidWithStoreCredit: false,
    });
    const noInvoices = db([]);
    noInvoices.invoiceItem.findMany.mockResolvedValue([]);
    expect(
      await loadSourceInvoicesState(noInvoices, [{ sourceInvoiceItemId: "ii-1" }]),
    ).toMatchObject({
      paidInFull: false,
      paidWithStoreCredit: false,
    });
  });

  describe("row 347 (3): a rebuilt source line re-resolves through its order line (the ONE resolver)", () => {
    /** the stored line id is gone; the live line carrying the order line sits on `inv-live` (status given) */
    const rebuilt = (invoiceStatus = "PAID") => {
      const d = db([{ amount: 30, status: "PAID", method: "CASH" }]);
      d.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
        where?.id
          ? []
          : [
              {
                id: "ii-new",
                invoiceId: "inv-live",
                orderItemId: "oi-1",
                invoice: { orderId: "ord-src", status: invoiceStatus },
              },
            ],
      );
      d.invoice.findMany.mockResolvedValue([
        paidInvoice({
          id: "inv-live",
          status: invoiceStatus,
          payments: [{ amount: 30, status: "PAID", method: "CASH" }],
        }),
      ]);
      return d;
    };
    const item = {
      sourceInvoiceItemId: "ii-old",
      sourceOrderItemId: "oi-1",
      sourceOrderId: "ord-src",
    };

    it("a rebuilt line on a paid invoice is paid in full: the invoice is the live line's", async () => {
      const s = await loadSourceInvoicesState(rebuilt(), [item]);
      expect(s.invoiceIds).toEqual(["inv-live"]);
      expect(s.paidInFull).toBe(true);
      expect(sourcesAreRefundable(s)).toBe(true);
    });

    it("a rebuilt line on a VOID invoice is dead: not paid in full", async () => {
      const s = await loadSourceInvoicesState(rebuilt("VOID"), [item]);
      expect(s.paidInFull).toBe(false);
    });

    describe("one order line billed on TWO invoices (a 6 + 4 partial split): every candidate is held to the gate", () => {
      const two = (second: { status?: string; paid: number }) => {
        const d = db([]);
        d.invoiceItem.findMany.mockImplementation(async ({ where }: any) =>
          where?.id
            ? []
            : ["inv-a", "inv-b"].map((invoiceId) => ({
                id: `ii-${invoiceId}`,
                invoiceId,
                orderItemId: "oi-1",
                invoice: { orderId: "ord-src", status: "PAID" },
              })),
        );
        d.invoice.findMany.mockResolvedValue([
          paidInvoice({
            id: "inv-a",
            payments: [{ amount: 30, status: "PAID", method: "CASH" }],
          }),
          paidInvoice({
            id: "inv-b",
            status: second.status ?? "PAID",
            payments: [{ amount: second.paid, status: "PAID", method: "CASH" }],
          }),
        ]);
        return d;
      };

      it("both paid in full: both are in the set and the refund may proceed", async () => {
        const s = await loadSourceInvoicesState(two({ paid: 30 }), [item]);
        expect(s.invoiceIds).toEqual(["inv-a", "inv-b"]);
        expect(s.paidInFull).toBe(true);
      });

      it("the invoice the resolver would NOT pick (higher id) owing: not paid in full, never paid against the other one", async () => {
        const s = await loadSourceInvoicesState(two({ paid: 10 }), [item]);
        expect(s.invoiceIds).toEqual(["inv-a", "inv-b"]);
        expect(s.paidInFull).toBe(false);
      });

      it("a voided candidate refuses too (fail closed for cash)", async () => {
        const s = await loadSourceInvoicesState(two({ status: "VOID", paid: 30 }), [item]);
        expect(s.paidInFull).toBe(false);
      });
    });

    it("a line that resolves nowhere (no order line either) fails closed, as before", async () => {
      const d = rebuilt();
      const s = await loadSourceInvoicesState(d, [
        { sourceInvoiceItemId: "ii-old", sourceOrderItemId: null, sourceOrderId: "ord-src" },
      ]);
      expect(s.paidInFull).toBe(false);
    });

    it("an item with no source line (unreferenced) is not refundable, even beside a resolvable one", async () => {
      const s = await loadSourceInvoicesState(rebuilt(), [item, { sourceInvoiceItemId: null }]);
      expect(s.paidInFull).toBe(false);
    });

    it("the lock set is re-resolved under the lock: a line moved to another invoice in between is a retryable 409", async () => {
      const d = rebuilt();
      let call = 0;
      d.invoiceItem.findMany.mockImplementation(async ({ where }: any) => {
        if (where?.id) return [];
        call += 1;
        // the first resolution (before the lock) names inv-live; after the lock the line sits on inv-other
        return [
          {
            id: "ii-new",
            invoiceId: call === 1 ? "inv-live" : "inv-other",
            orderItemId: "oi-1",
            invoice: { orderId: "ord-src", status: "PAID" },
          },
        ];
      });
      const lock = jest.fn().mockResolvedValue(undefined);
      await expect(
        loadSourceInvoicesState(d, [item], { beforeInvoiceRead: lock }),
      ).rejects.toMatchObject({
        status: 409,
        response: { code: "CONCURRENT_UPDATE", retryable: true },
      });
      expect(lock).toHaveBeenCalledWith(["inv-live"]);
      expect(d.invoice.findMany).not.toHaveBeenCalled(); // nothing was read, nothing paid against inv-live
    });

    it("the same resolution under the lock proceeds (an in-place rebuild does not refuse)", async () => {
      const lock = jest.fn().mockResolvedValue(undefined);
      const s = await loadSourceInvoicesState(rebuilt(), [item], { beforeInvoiceRead: lock });
      expect(lock).toHaveBeenCalledWith(["inv-live"]);
      expect(s.paidInFull).toBe(true);
    });
  });

  it("sourcesAreRefundable: paid in full AND not paid with store credit, nothing else", () => {
    expect(sourcesAreRefundable({ paidInFull: true, paidWithStoreCredit: false })).toBe(true);
    expect(sourcesAreRefundable({ paidInFull: true, paidWithStoreCredit: true })).toBe(false);
    expect(sourcesAreRefundable({ paidInFull: false, paidWithStoreCredit: false })).toBe(false);
    expect(sourcesAreRefundable({ paidInFull: false, paidWithStoreCredit: true })).toBe(false);
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
