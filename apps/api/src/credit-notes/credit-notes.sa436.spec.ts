import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { CreditNotesService } from "./credit-notes.service";
import { CreditNotesController } from "./credit-notes.controller";
import { PrismaService } from "../prisma/prisma.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { NumberingService } from "../import/numbering.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-436 / SA-436a (#2401) unit pins: the send-time sweep's tenant switch (OFF by default), the
 * per-note exclusion, the CreditNoteApplyBlock memory (its writers, clearers and both readers), the
 * InvoicePayment.autoApplied stamp, and the new endpoint's roles. The real-Postgres pins live in
 * credit-auto-apply-sa436.db.spec.ts.
 */
describe("CreditNotesService — SA-436 credit auto-apply off, exclusion and apply blocks", () => {
  let service: CreditNotesService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    const mod = await Test.createTestingModule({
      providers: [
        CreditNotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: RouteFlowGateway, useValue: { emitCreditNoteCreated: jest.fn() } },
        {
          provide: RegulatedLedgerService,
          useValue: {
            reverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
            unreverseCreditNoteEntries: jest.fn().mockResolvedValue(undefined),
          },
        },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn().mockResolvedValue(undefined),
            syncOrderInvoices: jest.fn().mockResolvedValue(undefined),
            removeInvoiceCommission: jest.fn().mockResolvedValue(undefined),
          },
        },
        { provide: NumberingService, useValue: { reserveNext: jest.fn() } },
      ],
    }).compile();
    service = mod.get(CreditNotesService);
  });

  const note = (id: string, amount: number, createdAt: string) => ({
    id,
    creditNoteNumber: `CN-${id}`,
    amount,
    amountUsed: 0,
    status: "ISSUED",
    customerId: "c1",
    expiresAt: null,
    appliedToInvoiceId: null,
    createdAt: new Date(createdAt),
  });
  const openInvoice = (id: string, total: number) => ({
    id,
    total,
    dueDate: null,
    status: "SENT",
    payments: [] as any[],
  });
  const switchOn = () =>
    (prisma.tenantConfig.findUnique as jest.Mock).mockResolvedValue({
      creditAutoApplyOnSend: true,
    });

  describe("the send-time sweep", () => {
    it("OFF by default: no config row ⇒ applies nothing and never reads a candidate", async () => {
      prisma.invoice.findUnique.mockResolvedValue(openInvoice("inv-1", 100));
      prisma.creditNote.findMany.mockResolvedValue([note("cn-a", 50, "2026-01-01")]);

      const res = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");

      expect(res).toEqual({ applied: 0, invoiceStatus: null });
      expect(prisma.tenantConfig.findUnique).toHaveBeenCalledWith({
        where: { tenantId: "test-tenant" },
        select: { creditAutoApplyOnSend: true },
      });
      expect(prisma.creditNote.findMany).not.toHaveBeenCalled();
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("OFF explicitly (creditAutoApplyOnSend false) ⇒ applies nothing", async () => {
      (prisma.tenantConfig.findUnique as jest.Mock).mockResolvedValue({
        creditAutoApplyOnSend: false,
      });
      prisma.invoice.findUnique.mockResolvedValue(openInvoice("inv-1", 100));
      prisma.creditNote.findMany.mockResolvedValue([note("cn-a", 50, "2026-01-01")]);

      const res = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");

      expect(res.applied).toBe(0);
      expect(prisma.invoicePayment.create).not.toHaveBeenCalled();
    });

    it("ON: the candidate query excludes notes an operator kept out (autoApplyExcluded: false)", async () => {
      switchOn();
      prisma.invoice.findUnique.mockResolvedValue(openInvoice("inv-1", 100));
      prisma.creditNote.findMany.mockResolvedValue([]);

      await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");

      expect(prisma.creditNote.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ autoApplyExcluded: false, status: { not: "VOID" } }),
        }),
      );
    });

    it("ON: a blocked pair is skipped; the next open note applies, stamped autoApplied", async () => {
      switchOn();
      prisma.invoice.findUnique.mockResolvedValue(openInvoice("inv-1", 30));
      prisma.creditNote.findMany.mockResolvedValue([
        note("cn-a", 50, "2026-01-01"),
        note("cn-b", 50, "2026-02-01"),
      ]);
      (prisma.creditNoteApplyBlock.findMany as jest.Mock).mockResolvedValue([
        { creditNoteId: "cn-a", invoiceId: "inv-1" },
      ]);

      const res = await service.autoApplyOldestCreditsInTx(prisma as any, "inv-1", "c1");

      expect(prisma.creditNoteApplyBlock.findMany).toHaveBeenCalledWith({
        where: { invoiceId: { in: ["inv-1"] } },
        select: { creditNoteId: true, invoiceId: true },
      });
      expect(res.applied).toBe(30);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ creditNoteId: "cn-b", amount: 30, autoApplied: true }),
      });
    });
  });

  describe("the manual apply", () => {
    it("writes a manual (autoApplied false) payment and lifts the pair's block", async () => {
      prisma.creditNote.findUnique.mockResolvedValue(note("cn-a", 50, "2026-01-01"));
      prisma.invoice.findUnique.mockResolvedValue({
        ...openInvoice("inv-1", 40),
        customerId: "c1",
      });

      await service.applyToInvoice("cn-a", "inv-1");

      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ creditNoteId: "cn-a", autoApplied: false }),
      });
      expect(prisma.creditNoteApplyBlock.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a", invoiceId: { in: ["inv-1"] } },
      });
    });
  });

  describe("settleOrderCreditsInTx", () => {
    it("skips a blocked (intent, invoice) pair and applies the intent to the next invoice", async () => {
      prisma.orderCreditNote.findMany.mockResolvedValue([
        {
          id: "ocn-1",
          creditNoteId: "cn-a",
          amount: 20,
          creditNote: note("cn-a", 50, "2026-01-01"),
        },
      ]);
      prisma.invoice.findMany.mockResolvedValue([
        openInvoice("inv-1", 100),
        openInvoice("inv-2", 100),
      ]);
      (prisma.creditNoteApplyBlock.findMany as jest.Mock).mockResolvedValue([
        { creditNoteId: "cn-a", invoiceId: "inv-1" },
      ]);
      prisma.creditNote.findUnique.mockResolvedValue(note("cn-a", 50, "2026-01-01"));
      prisma.invoice.findUnique.mockImplementation((args: any) =>
        Promise.resolve(openInvoice(args.where.id, 100)),
      );

      const res = await service.settleOrderCreditsInTx(prisma as any, "order-1");

      expect(res.applied).toBe(20);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ invoiceId: "inv-2", creditNoteId: "cn-a", amount: 20 }),
      });
    });
  });

  describe("syncOrderCreditSelections (SA-436a)", () => {
    const armOrder = (existing: any[]) => {
      prisma.orderCreditNote.findMany.mockResolvedValueOnce(existing);
      prisma.invoice.findMany.mockResolvedValue([{ id: "inv-1" }, { id: "inv-2" }]);
      prisma.creditNote.findMany.mockResolvedValue([
        { id: "cn-a", customerId: "c1", status: "ISSUED", expiresAt: null },
      ]);
    };

    it("reads only the order's non-VOID invoices for the block scope", async () => {
      armOrder([]);
      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", []);
      expect(prisma.invoice.findMany).toHaveBeenCalledWith({
        where: { orderId: "order-1", status: { not: "VOID" } },
        select: { id: true },
      });
    });

    it("an untick blocks the note on every non-VOID invoice of the order (UNTICKED, no actor)", async () => {
      armOrder([{ id: "ocn-1", orderId: "order-1", creditNoteId: "cn-a", amount: 40 }]);

      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", []);

      expect(prisma.orderCreditNote.delete).toHaveBeenCalledWith({ where: { id: "ocn-1" } });
      expect(prisma.creditNoteApplyBlock.createMany).toHaveBeenCalledWith({
        data: ["inv-1", "inv-2"].map((invoiceId) => ({
          tenantId: "test-tenant",
          creditNoteId: "cn-a",
          invoiceId,
          reason: "UNTICKED",
          createdById: null,
        })),
        skipDuplicates: true,
      });
    });

    it("a re-amount (40 → 25) lifts the note's blocks so settle re-applies at the new amount", async () => {
      armOrder([{ id: "ocn-1", orderId: "order-1", creditNoteId: "cn-a", amount: 40 }]);

      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", [
        { creditNoteId: "cn-a", amount: 25 },
      ]);

      expect(prisma.orderCreditNote.update).toHaveBeenCalledWith({
        where: { id: "ocn-1" },
        data: { amount: 25 },
      });
      expect(prisma.creditNoteApplyBlock.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a", invoiceId: { in: ["inv-1", "inv-2"] } },
      });
      expect(prisma.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
    });

    it("a (re-)tick lifts the note's blocks before the intent is written", async () => {
      armOrder([]);

      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", [
        { creditNoteId: "cn-a", amount: 10 },
      ]);

      expect(prisma.creditNoteApplyBlock.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: "cn-a", invoiceId: { in: ["inv-1", "inv-2"] } },
      });
      expect(prisma.orderCreditNote.create).toHaveBeenCalled();
    });

    it("an unchanged selection touches no block", async () => {
      armOrder([{ id: "ocn-1", orderId: "order-1", creditNoteId: "cn-a", amount: 40 }]);

      await service.syncOrderCreditSelections(prisma as any, "order-1", "c1", [
        { creditNoteId: "cn-a", amount: 40 },
      ]);

      expect(prisma.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
      expect(prisma.creditNoteApplyBlock.deleteMany).not.toHaveBeenCalled();
    });
  });

  describe("unapplyFromInvoice", () => {
    it("remembers the removal: an UNAPPLIED block for the pair, stamped with the actor", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([
        {
          id: "pay-1",
          invoiceId: "inv-1",
          creditNoteId: "cn-a",
          amount: 15,
          status: "PAID",
          method: "CREDIT_NOTE",
          createdAt: new Date(),
        },
      ]);
      prisma.creditNote.findUnique.mockResolvedValue({
        ...note("cn-a", 50, "2026-01-01"),
        amountUsed: 15,
      });
      prisma.invoice.findUnique.mockResolvedValue(openInvoice("inv-1", 100));

      await service.unapplyFromInvoice("cn-a", "inv-1", "user-7");

      expect(prisma.creditNoteApplyBlock.createMany).toHaveBeenCalledWith({
        data: [
          {
            tenantId: "test-tenant",
            creditNoteId: "cn-a",
            invoiceId: "inv-1",
            reason: "UNAPPLIED",
            createdById: "user-7",
          },
        ],
        skipDuplicates: true,
      });
    });

    it("a refusal (no active application) writes no block", async () => {
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      await expect(service.unapplyFromInvoice("cn-a", "inv-1", "user-7")).rejects.toThrow();
      expect(prisma.creditNoteApplyBlock.createMany).not.toHaveBeenCalled();
    });
  });

  describe("setAutoApplyExcluded", () => {
    it("sets the flag and audits it with the actor", async () => {
      prisma.creditNote.findFirst.mockResolvedValue({ id: "cn-a" });
      prisma.creditNote.update.mockResolvedValue({ id: "cn-a", autoApplyExcluded: true });

      const res = await service.setAutoApplyExcluded("cn-a", true, "user-7");

      expect(res).toEqual({ id: "cn-a", autoApplyExcluded: true });
      expect(prisma.creditNote.update).toHaveBeenCalledWith({
        where: { id: "cn-a" },
        data: { autoApplyExcluded: true },
      });
      expect(prisma.auditLog.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          userId: "user-7",
          entityType: "CreditNote",
          action: "EXCLUDED",
          entityId: "cn-a",
          meta: { excluded: true },
        }),
      });
    });

    it("the lookup goes through the tenant-scoped findFirst (a foreign tenant's id ⇒ 404)", async () => {
      prisma.creditNote.findFirst.mockResolvedValue(null); // the proxy's tenantId filter matched nothing
      prisma.creditNote.findUnique.mockResolvedValue({ id: "cn-foreign" }); // must not be consulted
      await expect(
        service.setAutoApplyExcluded("cn-foreign", true, "user-7"),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.creditNote.findFirst).toHaveBeenCalledWith({
        where: { id: "cn-foreign" },
        select: { id: true },
      });
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });

    it("a missing note ⇒ 404 and zero writes", async () => {
      prisma.creditNote.findFirst.mockResolvedValue(null);
      await expect(service.setAutoApplyExcluded("nope", true, "user-7")).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.creditNote.update).not.toHaveBeenCalled();
      expect(prisma.auditLog.create).not.toHaveBeenCalled();
    });
  });
});

describe("CreditNotesController — SA-436 exclusion endpoint roles", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const handler = CreditNotesController.prototype.setAutoApplyExclusion;
  const ctxFor = (role: UserRole) =>
    ({
      getHandler: () => handler,
      getClass: () => CreditNotesController,
      switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
    }) as any;

  it("declares OPERATOR and TENANT_ADMIN", () => {
    expect(reflector.get(ROLES_KEY, handler)).toEqual([UserRole.OPERATOR, UserRole.TENANT_ADMIN]);
  });

  it.each([
    [UserRole.OPERATOR, true],
    [UserRole.TENANT_ADMIN, true],
    [UserRole.DRIVER, false],
    [UserRole.CUSTOMER, false],
  ])("%s ⇒ allowed %s", (role, allowed) => {
    expect(guard.canActivate(ctxFor(role))).toBe(allowed);
  });
});
