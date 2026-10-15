import { Test } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { CreditNotesService } from "./credit-notes.service";
import { codeOf } from "./credit-note-errors";
import { API_ERROR_CODES as CODES } from "../common/api-error-codes";
import { CreditNotesController } from "./credit-notes.controller";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-436 PR-2 (#2402) unit pins: void-with-reversal and its read-only preview. The real-Postgres
 * pins live in credit-note-void-reversal.db.spec.ts.
 */
describe("CreditNotesService — SA-436 PR-2 void-with-reversal", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let ledger: { unreverseCreditNoteEntries: jest.Mock; reverseCreditNoteEntries: jest.Mock };
  let gateway: { emitCreditNoteVoided: jest.Mock; emitCreditNoteCreated: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = {
      unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
      reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
    };
    gateway = { emitCreditNoteVoided: jest.fn(), emitCreditNoteCreated: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: gateway },
        { provide: RegulatedLedgerService, useValue: ledger },
        {
          provide: CommissionEngineService,
          useValue: { syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  // cn-a ($60) is applied $40 to inv-2 (order o-2) and $20 to inv-1 (order o-1); both invoices
  // are otherwise unpaid, so reversing reopens inv-2 PAID → SENT and inv-1 PARTIAL → SENT.
  const inv = (id: string, orderId: string, total: number, status: string, cnPay: any) => ({
    id,
    invoiceNumber: `INV-${id}`,
    orderId,
    total,
    dueDate: null,
    status,
    payments: [cnPay],
  });
  const pay = (id: string, invoiceId: string, amount: number) => ({
    id,
    invoiceId,
    creditNoteId: "cn-a",
    amount,
    status: "PAID",
    method: "CREDIT_NOTE",
  });
  const p2 = pay("pay-2", "inv-2", 40);
  const p1 = pay("pay-1", "inv-1", 20);
  const livePayments = [
    { ...p2, invoice: inv("inv-2", "o-2", 40, "PAID", p2) },
    { ...p1, invoice: inv("inv-1", "o-1", 50, "PARTIAL", p1) },
  ];
  const armNote = (over: Record<string, unknown> = {}) =>
    prisma.creditNote.findFirst.mockResolvedValue({
      id: "cn-a",
      creditNoteNumber: "CN-1",
      status: "APPLIED",
      amount: 60,
      amountUsed: 60,
      ...over,
    });
  const armRestore = () => {
    prisma.creditNote.findUnique.mockResolvedValue({
      id: "cn-a",
      creditNoteNumber: "CN-1",
      customerId: "c1",
      amount: 60,
      amountUsed: 60,
      status: "APPLIED",
    });
    prisma.invoice.findUnique.mockImplementation((args: any) =>
      Promise.resolve({
        id: args.where.id,
        total: args.where.id === "inv-2" ? 40 : 50,
        dueDate: null,
        status: args.where.id === "inv-2" ? "PAID" : "PARTIAL",
        payments: [],
      }),
    );
    prisma.creditNote.updateMany.mockResolvedValue({ count: 1 });
  };
  const noWrites = () => {
    expect(prisma.invoicePayment.delete).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.update).not.toHaveBeenCalled();
    expect(prisma.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
    expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
    expect(prisma.creditNote.updateMany).not.toHaveBeenCalled();
    expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  };

  describe("voidPreview", () => {
    it("lists each invoice it reopens, by how much, with its status before and after", async () => {
      armNote();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      const res = await service.voidPreview("cn-a");

      expect(res.refusal).toBeNull();
      expect(res.restoresTotal).toBe(60);
      expect(res.invoices).toEqual([
        {
          invoiceId: "inv-2",
          invoiceNumber: "INV-inv-2",
          amount: 40,
          statusBefore: "PAID",
          statusAfter: "SENT",
        },
        {
          invoiceId: "inv-1",
          invoiceNumber: "INV-inv-1",
          amount: 20,
          statusBefore: "PARTIAL",
          statusAfter: "SENT",
        },
      ]);
      expect(prisma.invoicePayment.delete).not.toHaveBeenCalled(); // read-only
    });

    it("reports the refusal the void would return (a note backing a live return)", async () => {
      armNote();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      prisma.return.findFirst.mockResolvedValue({ returnNumber: "RET-9" });

      const res = await service.voidPreview("cn-a");

      expect(res.refusal).toMatch(/backs a return \(RET-9\)/);
      expect(prisma.return.findFirst).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a", status: { notIn: ["CANCELLED", "REJECTED"] } },
        select: { returnNumber: true },
      });
    });
  });

  describe("voidWithReversal", () => {
    it("locks Orders (sorted), then Invoices (sorted), then the CreditNote — before any write", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      const exec = jest.fn().mockResolvedValue(0);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
        fn({ ...prisma, $executeRaw: exec }),
      );

      await service.voidWithReversal("cn-a", "user-7");

      const locked = exec.mock.calls.map(
        (c: any[]) => `${c[0].join("?").match(/FROM "(\w+)"/)[1]}:${c[1]}`,
      );
      expect(locked.slice(0, 5)).toEqual([
        "Order:o-1",
        "Order:o-2",
        "Invoice:inv-1",
        "Invoice:inv-2",
        "CreditNote:cn-a",
      ]);
    });

    it("B1052: every lock the void takes is tenant-scoped (a foreign id can't lock another tenant's rows)", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const exec = jest.fn().mockResolvedValue(0);
      await service.voidWithReversalInTx({ ...prisma, $executeRaw: exec }, "cn-a", "user-7", null);
      const locks = exec.mock.calls
        .map((c: any[]) => ({ sql: c[0].join("?"), values: c.slice(1) }))
        .filter((l) => /FOR (NO KEY )?UPDATE/.test(l.sql));
      // 2 orders + 2 invoices + the note itself (the restores' own note locks come after).
      expect(locks.length).toBeGreaterThanOrEqual(5);
      // SA-706a: the note's own lock is NO KEY UPDATE (its FK holders take KEY SHARE); Order and
      // Invoice locks stay FOR UPDATE.
      for (const l of locks) {
        expect(l.sql).toMatch(
          /FROM "CreditNote"/.test(l.sql) ? / FOR NO KEY UPDATE$/ : /(?<!NO KEY) FOR UPDATE$/,
        );
      }
      for (const l of locks) {
        expect(l.sql).toMatch(/"tenantId"/);
        expect(l.values).toContain("test-tenant");
      }
    });

    it("B949: the note's OWN void passes voidingNoteId to every restore (the one exemption from the SOURCE_DELETED guard, scoped to THAT note)", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const restore = jest.spyOn(service as any, "restoreCreditFromPaymentInTx");
      const exec = jest.fn().mockResolvedValue(0);
      await service.voidWithReversalInTx({ ...prisma, $executeRaw: exec }, "cn-a", "user-7", null);
      expect(restore).toHaveBeenCalledTimes(2);
      for (const call of restore.mock.calls) expect(call[4]).toEqual({ voidingNoteId: "cn-a" });
      restore.mockRestore();
    });

    it("SA-608g: an optional `extra` set (the reissue's SOURCE invoice and order) joins the SAME sorted Order and Invoice sets, de-duplicated, before the CreditNote", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const exec = jest.fn().mockResolvedValue(0);
      const tx = { ...prisma, $executeRaw: exec };

      await service.voidWithReversalInTx(tx, "cn-a", "user-7", null, undefined, {
        orderIds: ["o-9", "o-0", "o-1"], // o-1 is already in the set
        invoiceIds: ["inv-5", "inv-1"], // inv-1 is already in the set
      });

      const locked = exec.mock.calls.map(
        (c: any[]) => `${c[0].join("?").match(/FROM "(\w+)"/)[1]}:${c[1]}`,
      );
      expect(locked.slice(0, 8)).toEqual([
        "Order:o-0",
        "Order:o-1",
        "Order:o-2",
        "Order:o-9",
        "Invoice:inv-1",
        "Invoice:inv-2",
        "Invoice:inv-5",
        "CreditNote:cn-a",
      ]);
    });

    it("SA-608g: with no `extra` (the endpoint) the lock set is exactly what it was", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const exec = jest.fn().mockResolvedValue(0);
      await service.voidWithReversalInTx({ ...prisma, $executeRaw: exec }, "cn-a", "user-7", null);
      const locked = exec.mock.calls.map(
        (c: any[]) => `${c[0].join("?").match(/FROM "(\w+)"/)[1]}:${c[1]}`,
      );
      expect(locked.slice(0, 5)).toEqual([
        "Order:o-1",
        "Order:o-2",
        "Invoice:inv-1",
        "Invoice:inv-2",
        "CreditNote:cn-a",
      ]);
    });

    it("SA-498a: an order holding only an intent (no payment) joins the sorted Order lock set", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      // o-0 and o-3 carry this note's intent rows but no payment of it; o-2 has both.
      prisma.orderCreditNote.findMany.mockResolvedValue([
        { orderId: "o-3" },
        { orderId: "o-0" },
        { orderId: "o-2" },
      ]);
      const exec = jest.fn().mockResolvedValue(0);
      (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
        fn({ ...prisma, $executeRaw: exec }),
      );

      await service.voidWithReversal("cn-a", "user-7");

      expect(prisma.orderCreditNote.findMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a" },
        select: { orderId: true },
      });
      const locked = exec.mock.calls.map(
        (c: any[]) => `${c[0].join("?").match(/FROM "(\w+)"/)[1]}:${c[1]}`,
      );
      expect(locked.slice(0, 7)).toEqual([
        "Order:o-0",
        "Order:o-1",
        "Order:o-2",
        "Order:o-3",
        "Invoice:inv-1",
        "Invoice:inv-2",
        "CreditNote:cn-a",
      ]);
      // ...and the rows it then deletes are exactly those intents, under those locks.
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a" },
      });
    });

    it("restores every application, blocks each pair, drops the intents, voids, un-reverses and audits", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      const res = await service.voidWithReversal("cn-a", "user-7");

      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-2" } });
      expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
      expect(res.reopened).toEqual([
        { invoiceId: "inv-2", invoiceNumber: "INV-inv-2", amount: 40 },
        { invoiceId: "inv-1", invoiceNumber: "INV-inv-1", amount: 20 },
      ]);
      expect(prisma.creditNoteApplyBlock.createMany).toHaveBeenCalledWith({
        data: ["inv-2", "inv-1"].map((invoiceId) => ({
          tenantId: "test-tenant",
          creditNoteId: "cn-a",
          invoiceId,
          reason: "VOID_REVERSAL",
          createdById: "user-7",
        })),
        skipDuplicates: true,
      });
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a" },
      });
      expect(prisma.creditNote.updateMany).toHaveBeenCalledWith({
        where: { id: "cn-a", status: { not: "VOID" }, amountUsed: 0 },
        data: { status: "VOID" },
      });
      expect(ledger.unreverseCreditNoteEntries).toHaveBeenCalledWith({
        creditNoteId: "cn-a",
        db: expect.objectContaining({ creditNote: prisma.creditNote }), // the void's own tx
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-7",
          entityType: "CreditNote",
          action: "VOIDED",
          entityId: "cn-a",
        }),
      });
      expect(gateway.emitCreditNoteVoided).toHaveBeenCalled();
    });

    it("#2540: the optional void reason is recorded in the VOIDED audit row, trimmed", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      await service.voidWithReversal("cn-a", "user-7", "  duplicate of CN-0042  ");

      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: "VOIDED",
          meta: expect.objectContaining({ reason: "duplicate of CN-0042" }),
        }),
      });
    });

    it("#2540: no reason (or a blank one) leaves the audit meta without a reason key", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      await service.voidWithReversal("cn-a", "user-7", "   ");

      const meta = prisma.auditLog.create.mock.calls[0][0].data.meta;
      expect(meta).not.toHaveProperty("reason");
      expect(meta).toHaveProperty("reversed");
    });

    it("#2540: the reopened invoice's overdue is judged in the TENANT zone, not UTC", async () => {
      jest.useFakeTimers().setSystemTime(new Date("2026-09-10T03:00:00Z"));
      try {
        armNote();
        armRestore();
        // Due 2026-09-09: over in UTC (03:00Z on the 10th) but still running in Honolulu (UTC-10).
        prisma.invoice.findUnique.mockImplementation((args: any) =>
          Promise.resolve({
            id: args.where.id,
            total: args.where.id === "inv-2" ? 40 : 50,
            dueDate: new Date("2026-09-09T00:00:00Z"),
            status: "PAID",
            payments: [],
          }),
        );
        prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
        prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "Pacific/Honolulu" });

        await service.voidWithReversal("cn-a", "user-7");

        const statuses = prisma.invoice.update.mock.calls.map((c: any) => c[0].data.status);
        expect(statuses.length).toBeGreaterThan(0);
        expect(statuses.every((st: string) => st === "SENT")).toBe(true);
      } finally {
        jest.useRealTimers();
      }
    });

    it("an unused note voids with no restores and no blocks", async () => {
      armNote({ status: "ISSUED", amountUsed: 0 });
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue([]);

      const res = await service.voidWithReversal("cn-a", "user-7");

      expect(res.reopened).toEqual([]);
      expect(prisma.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
      expect(prisma.creditNote.updateMany).toHaveBeenCalled();
    });

    // B957: POST :id/void was a SECOND void door (skipped CREDIT_NOTE_RETURN_BACKED and the reason/actor audit). It now
    // delegates to voidWithReversal; the URL stays, voidCreditNote is gone.
    describe("B957: POST :id/void is the SAME door as :id/void-with-reversal", () => {
      const door = () =>
        new CreditNotesController(service as never, {} as never).voidNote(
          "cn-a",
          { sub: "user-7" } as never,
          { reason: "  duplicate  " } as never,
        );

      it("SA-630a: the kept URL is marked deprecated in Swagger", () => {
        const meta = Reflect.getMetadata(
          "swagger/apiOperation",
          CreditNotesController.prototype.voidNote,
        );
        expect(meta).toMatchObject({ deprecated: true });
      });
      it("the service has no second void method", () => {
        expect((service as any).voidCreditNote).toBeUndefined();
      });
      it("the kept URL still answers the voided credit-note row (old clients read .status), not the wrapper", async () => {
        armNote({ status: "ISSUED", amountUsed: 0 });
        armRestore();
        prisma.invoicePayment.findMany.mockResolvedValue([]);
        prisma.creditNote.findUnique.mockResolvedValue({ id: "cn-a", status: "VOID" });
        const res: any = await door();
        expect(res).toMatchObject({ id: "cn-a", status: "VOID" });
        expect(res.creditNote).toBeUndefined();
      });
      it("a return-backed note is a 409 CREDIT_NOTE_RETURN_BACKED and NOTHING changes", async () => {
        armNote();
        prisma.return.findFirst.mockResolvedValue({ returnNumber: "RET-9" });
        prisma.invoicePayment.findMany.mockResolvedValue([]);
        const err = await door().catch((e: unknown) => e);
        expect(codeOf(err)).toBe(CODES.CREDIT_NOTE_RETURN_BACKED);
        noWrites();
        expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
      });
      it("a plain unused note is voided and leaves an audit row naming the actor and the reason", async () => {
        armNote({ status: "ISSUED", amountUsed: 0 });
        armRestore();
        prisma.invoicePayment.findMany.mockResolvedValue([]);
        await door();
        expect(prisma.creditNote.updateMany).toHaveBeenCalled();
        expect(prisma.auditLog.create).toHaveBeenCalledWith({
          data: expect.objectContaining({
            userId: "user-7",
            action: "VOIDED",
            entityType: "CreditNote",
            entityId: "cn-a",
            meta: expect.objectContaining({ reason: "duplicate" }),
          }),
        });
        expect(gateway.emitCreditNoteVoided).toHaveBeenCalled();
      });
      it("a note in use behaves exactly like the main void path: its applications are reversed, then it is voided", async () => {
        armNote();
        armRestore();
        prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
        await door();
        expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-2" } });
        expect(prisma.invoicePayment.delete).toHaveBeenCalledWith({ where: { id: "pay-1" } });
      });
    });

    it.each([
      ["already VOID", () => armNote({ status: "VOID" }), /already void/],
      [
        "backs a live return",
        () => {
          armNote();
          prisma.return.findFirst.mockResolvedValue({ returnNumber: null });
        },
        /backs a return\. Cancel the return/,
      ],
      [
        "consumed beyond its invoice applications",
        () => armNote({ amountUsed: 75 }),
        /RETURN_CREDIT_CONSUMED/,
      ],
    ])("refuses (400, readable) when %s — and writes nothing", async (_n, arm, msg) => {
      arm();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      const err = await service.voidWithReversal("cn-a", "user-7").catch((e: unknown) => e);

      expect(err).toBeInstanceOf(BadRequestException);
      expect((err as Error).message).toMatch(msg);
      noWrites();
      expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
    });

    it.each([
      ["already void", () => armNote({ status: "VOID" }), CODES.CREDIT_NOTE_VOID_NOT_EDITABLE],
      [
        "backs a live return",
        () => {
          armNote();
          prisma.return.findFirst.mockResolvedValue({ returnNumber: "RET-9" });
        },
        CODES.CREDIT_NOTE_RETURN_BACKED,
      ],
      [
        "consumed beyond its applications",
        () => armNote({ amountUsed: 75 }),
        CODES.CREDIT_NOTE_CREDIT_CONSUMED,
      ],
    ])("PR-C: the refusal when %s carries its CREDIT_NOTE_* code", async (_n, arm, code) => {
      arm();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const err = await service.voidWithReversal("cn-a", "user-7").catch((e: unknown) => e);
      expect(codeOf(err)).toBe(code);
    });

    it("SA-608h: exhausted Serializable retries (P2034) are a 409 CHANGED_CONCURRENTLY, never a raw 500", async () => {
      armNote();
      armRestore();
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const conflict = Object.assign(new Error("write conflict"), { code: "P2034" });
      prisma.tenantTransaction.mockRejectedValue(conflict);

      const err: any = await service.voidWithReversal("cn-a", "user-7").catch((e: unknown) => e);

      expect(err?.getStatus?.()).toBe(409);
      expect(codeOf(err)).toBe(CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY);
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(3); // the bounded retry ran first
      expect(gateway.emitCreditNoteVoided).not.toHaveBeenCalled();
    });

    it("SA-608h: any other error still propagates untouched", async () => {
      armNote();
      armRestore();
      const boom = new Error("boom");
      prisma.tenantTransaction.mockRejectedValue(boom);
      await expect(service.voidWithReversal("cn-a", "user-7")).rejects.toBe(boom);
    });

    it("PR-C: a lost compare-and-set is CHANGED_CONCURRENTLY", async () => {
      armNote();
      armRestore();
      prisma.creditNote.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);
      const err = await service.voidWithReversal("cn-a", "user-7").catch((e: unknown) => e);
      expect(codeOf(err)).toBe(CODES.CREDIT_NOTE_CHANGED_CONCURRENTLY);
    });

    it("a lost compare-and-set (the note changed) refuses rather than half-voiding", async () => {
      armNote();
      armRestore();
      prisma.creditNote.updateMany.mockResolvedValue({ count: 0 });
      prisma.invoicePayment.findMany.mockResolvedValue(livePayments);

      await expect(service.voidWithReversal("cn-a", "user-7")).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(ledger.unreverseCreditNoteEntries).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});

describe("CreditNotesController — SA-436 PR-2 void endpoints roles", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const ctxFor = (handler: any, role: UserRole) =>
    ({
      getHandler: () => handler,
      getClass: () => CreditNotesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as any;

  it.each([
    ["voidWithReversal", CreditNotesController.prototype.voidWithReversal],
    ["voidPreview", CreditNotesController.prototype.voidPreview],
  ])("%s: OPERATOR/TENANT_ADMIN allowed, DRIVER/CUSTOMER 403", (_n, handler) => {
    expect(guard.canActivate(ctxFor(handler, UserRole.OPERATOR))).toBe(true);
    expect(guard.canActivate(ctxFor(handler, UserRole.TENANT_ADMIN))).toBe(true);
    expect(guard.canActivate(ctxFor(handler, UserRole.DRIVER))).toBe(false);
    expect(guard.canActivate(ctxFor(handler, UserRole.CUSTOMER))).toBe(false);
  });
});
