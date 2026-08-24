import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { SalesAgentsService } from "./sales-agents.service";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { CommissionEngineService } from "./commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";

function mockModel() {
  return {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn().mockResolvedValue(null),
    findUnique: jest.fn().mockResolvedValue(null),
    create: jest
      .fn()
      .mockImplementation((args: any) => Promise.resolve({ id: "new-id", ...args.data })),
    update: jest
      .fn()
      .mockImplementation((args: any) => Promise.resolve({ id: args.where.id, ...args.data })),
    updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    delete: jest.fn().mockResolvedValue({}),
    aggregate: jest.fn().mockResolvedValue({ _sum: {} }),
    count: jest.fn().mockResolvedValue(0),
  };
}

/**
 * The sales-agents models (SalesAgent, SalesAgentRate, ...) are not in
 * testing/prisma-mock.ts's fixed model list — that file is outside this work
 * package's file allowlist, so extend a fresh createMockPrisma() locally
 * instead of editing it. `extra`'s object identities are shared between
 * `prisma.forTenant()` and the `tx` handed to `tenantTransaction` callbacks,
 * so mocking `models.salesAgent.findUnique` affects both call shapes.
 */
function extendWithSalesAgentModels(prisma: ReturnType<typeof createMockPrisma>) {
  const extra = {
    salesAgent: mockModel(),
    salesAgentRate: mockModel(),
    customerCommissionRate: mockModel(),
    agentAssignment: mockModel(),
    commissionAccrual: mockModel(),
    commissionAdjustment: mockModel(),
    commissionStatement: mockModel(),
    commissionStatementLine: mockModel(),
    commissionPayout: mockModel(),
  };
  Object.assign(prisma, extra);
  const forTenantResult = { ...(prisma as any).forTenant(), ...extra };
  (prisma.forTenant as jest.Mock).mockReturnValue(forTenantResult);
  (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
    fn({ ...forTenantResult, $executeRaw: jest.fn(), $queryRaw: jest.fn() }),
  );
  return extra;
}

describe("SalesAgentsService", () => {
  let service: SalesAgentsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let models: ReturnType<typeof extendWithSalesAgentModels>;
  let commissionEngine: { recomputeCommissionRange: jest.Mock };
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    models = extendWithSalesAgentModels(prisma);
    commissionEngine = {
      recomputeCommissionRange: jest.fn().mockResolvedValue({ invoicesSynced: 0 }),
    };
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const mod = await Test.createTestingModule({
      providers: [
        SalesAgentsService,
        { provide: PrismaService, useValue: prisma },
        { provide: CommissionEngineService, useValue: commissionEngine },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();
    service = mod.get(SalesAgentsService);
  });

  describe("updateStatus", () => {
    it("sets stopNewBusinessAt on entering STOPPED_FOR_NEW and audit-logs the transition", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });

      await service.updateStatus("a1", { status: "STOPPED_FOR_NEW" as any }, { sub: "u1" } as any);

      expect(models.salesAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "a1" },
          data: expect.objectContaining({
            status: "STOPPED_FOR_NEW",
            stopNewBusinessAt: expect.any(Date),
          }),
        }),
      );
      expect(audit.log).toHaveBeenCalledWith(
        expect.objectContaining({ action: "salesAgent.status", entityId: "a1" }),
      );
    });

    it("uses a given stopNewBusinessAt instead of defaulting to now", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      const chosen = new Date("2026-06-01T00:00:00.000Z");

      await service.updateStatus(
        "a1",
        { status: "STOPPED_FOR_NEW" as any, stopNewBusinessAt: chosen.toISOString() },
        { sub: "u1" } as any,
      );

      expect(models.salesAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ stopNewBusinessAt: chosen }) }),
      );
    });

    it("clears stopNewBusinessAt when leaving STOPPED_FOR_NEW", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "STOPPED_FOR_NEW",
        deletedAt: null,
        stopNewBusinessAt: new Date("2026-01-01"),
      });

      await service.updateStatus("a1", { status: "ACTIVE" as any }, { sub: "u1" } as any);

      expect(models.salesAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: "ACTIVE", stopNewBusinessAt: null }),
        }),
      );
    });

    it("leaves stopNewBusinessAt untouched on a non-STOPPED_FOR_NEW-involving transition", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });

      await service.updateStatus("a1", { status: "PAUSED" as any }, { sub: "u1" } as any);

      const call = models.salesAgent.update.mock.calls[0][0];
      expect(call.data).not.toHaveProperty("stopNewBusinessAt");
    });
  });

  describe("removeRate", () => {
    it("blocks deleting a past rate", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      models.salesAgentRate.findUnique.mockResolvedValue({
        id: "r1",
        agentId: "a1",
        effectiveFrom: new Date(Date.now() - 86_400_000),
      });

      await expect(service.removeRate("a1", "r1")).rejects.toBeInstanceOf(BadRequestException);
      expect(models.salesAgentRate.delete).not.toHaveBeenCalled();
    });

    it("allows deleting a future-dated rate", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      models.salesAgentRate.findUnique.mockResolvedValue({
        id: "r1",
        agentId: "a1",
        effectiveFrom: new Date(Date.now() + 86_400_000),
      });

      await service.removeRate("a1", "r1");

      expect(models.salesAgentRate.delete).toHaveBeenCalledWith({ where: { id: "r1" } });
    });
  });

  describe("addRate", () => {
    it("does not recompute for a present/future-dated rate", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      const future = new Date(Date.now() + 86_400_000).toISOString();

      const result = await service.addRate("a1", { ratePct: 5, effectiveFrom: future });

      expect(commissionEngine.recomputeCommissionRange).not.toHaveBeenCalled();
      expect(result).toEqual(expect.objectContaining({ rate: expect.any(Object) }));
      expect(result).not.toHaveProperty("recompute");
    });

    it("triggers an agent-scoped recompute for a backdated rate, from the given date", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      const past = new Date(Date.now() - 30 * 86_400_000);

      await service.addRate("a1", { ratePct: 7, effectiveFrom: past.toISOString() });

      expect(commissionEngine.recomputeCommissionRange).toHaveBeenCalledTimes(1);
      const [scope, fromDate] = commissionEngine.recomputeCommissionRange.mock.calls[0];
      expect(scope).toEqual({ agentId: "a1" });
      expect((fromDate as Date).getTime()).toBe(past.getTime());
    });
  });

  describe("addCustomerRate", () => {
    it("triggers a customer-scoped recompute for a backdated customer rate", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      const past = new Date(Date.now() - 5 * 86_400_000);

      await service.addCustomerRate("a1", {
        customerId: "c1",
        ratePct: 10,
        effectiveFrom: past.toISOString(),
      });

      expect(commissionEngine.recomputeCommissionRange).toHaveBeenCalledWith(
        { customerId: "c1" },
        past,
      );
    });
  });

  describe("assignment interval guard", () => {
    const activeAgent = { id: "a1", status: "ACTIVE", deletedAt: null };

    it("rejects an assignment backdated before the open row's own effectiveFrom", async () => {
      models.salesAgent.findUnique.mockResolvedValue(activeAgent);
      models.agentAssignment.findFirst.mockResolvedValue({
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      });

      await expect(
        service.addAssignment("a1", {
          customerId: "c1",
          effectiveFrom: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(models.agentAssignment.updateMany).not.toHaveBeenCalled();
      expect(models.agentAssignment.create).not.toHaveBeenCalled();
      expect(commissionEngine.recomputeCommissionRange).not.toHaveBeenCalled();
    });

    it("closes the open row and creates the new one when the date is after it", async () => {
      models.salesAgent.findUnique.mockResolvedValue(activeAgent);
      models.agentAssignment.findFirst.mockResolvedValue({
        effectiveFrom: new Date("2026-01-01T00:00:00.000Z"),
      });
      const past = new Date(Date.now() - 86_400_000);

      await service.addAssignment("a1", { customerId: "c1", effectiveFrom: past.toISOString() });

      expect(models.agentAssignment.updateMany).toHaveBeenCalledWith({
        where: { customerId: "c1", effectiveTo: null },
        data: { effectiveTo: past },
      });
      expect(models.agentAssignment.create).toHaveBeenCalledTimes(1);
      expect(commissionEngine.recomputeCommissionRange).toHaveBeenCalledWith(
        { customerId: "c1" },
        past,
      );
    });

    it("fails the whole bulk batch — writing nothing — when one customer would invert", async () => {
      models.salesAgent.findUnique.mockResolvedValue(activeAgent);
      models.agentAssignment.findFirst.mockResolvedValue({
        effectiveFrom: new Date("2026-06-01T00:00:00.000Z"),
      });

      await expect(
        service.addAssignmentsBulk("a1", {
          customerIds: ["c1", "c2"],
          effectiveFrom: "2026-01-01T00:00:00.000Z",
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(models.agentAssignment.updateMany).not.toHaveBeenCalled();
      expect(models.agentAssignment.create).not.toHaveBeenCalled();
    });

    it("rejects closing an assignment at its own effectiveFrom", async () => {
      const start = new Date("2026-06-01T00:00:00.000Z");
      models.agentAssignment.findFirst.mockResolvedValue({ effectiveFrom: start });

      await expect(
        service.closeAssignment({ customerId: "c1", effectiveTo: start.toISOString() }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(models.agentAssignment.updateMany).not.toHaveBeenCalled();
    });
  });

  describe("remove", () => {
    it("409s when a non-PAID statement is outstanding", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      models.commissionAccrual.findMany.mockResolvedValue([]);
      models.commissionStatement.findFirst.mockResolvedValue({ id: "s1", status: "PENDING" });

      await expect(service.remove("a1")).rejects.toBeInstanceOf(ConflictException);
      expect(models.salesAgent.update).not.toHaveBeenCalled();
    });

    it("409s when claimed commission has not converged", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      models.commissionAccrual.findMany.mockResolvedValue([
        { id: "acc1", payableAmount: 100, claimedAmount: 40, adjustments: [] },
      ]);
      models.commissionStatement.findFirst.mockResolvedValue(null);

      await expect(service.remove("a1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("soft-deletes when nothing is outstanding", async () => {
      models.salesAgent.findUnique.mockResolvedValue({
        id: "a1",
        status: "ACTIVE",
        deletedAt: null,
      });
      models.commissionAccrual.findMany.mockResolvedValue([]);
      models.commissionStatement.findFirst.mockResolvedValue(null);

      await service.remove("a1");

      expect(models.salesAgent.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "a1" },
          data: expect.objectContaining({ deletedAt: expect.any(Date) }),
        }),
      );
    });
  });
});
