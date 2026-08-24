import { Test } from "@nestjs/testing";
import { BadRequestException, ConflictException } from "@nestjs/common";
import { CommissionStatementsService } from "./commission-statements.service";
import { PrismaService } from "../prisma/prisma.service";
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
 * The sales-agents models are not in testing/prisma-mock.ts's fixed model
 * list — see the identical note in sales-agents.service.spec.ts. `expense`
 * and `expenseCategory` ARE already in createMockPrisma()'s base model set,
 * so they're carried through by the `...(prisma as any).forTenant()` spread
 * below rather than re-declared here.
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

describe("CommissionStatementsService", () => {
  let service: CommissionStatementsService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let models: ReturnType<typeof extendWithSalesAgentModels>;

  beforeEach(async () => {
    prisma = createMockPrisma();
    models = extendWithSalesAgentModels(prisma);
    const mod = await Test.createTestingModule({
      providers: [CommissionStatementsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = mod.get(CommissionStatementsService);
    // Default: no PENDING statement, no prior CST-#### number, nothing to sweep —
    // individual tests override what they need.
    models.commissionStatement.findFirst.mockResolvedValue(null);
    models.commissionStatement.findMany.mockResolvedValue([]);
    models.commissionAccrual.findMany.mockResolvedValue([]);
  });

  describe("generate", () => {
    it("409s when a PENDING statement already exists for the agent", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });
      models.commissionStatement.findFirst.mockResolvedValue({
        id: "s0",
        statementNumber: "CST-2026-0001",
      });

      await expect(service.generate({ agentId: "a1" })).rejects.toBeInstanceOf(ConflictException);
      expect(models.commissionStatementLine.create).not.toHaveBeenCalled();
    });

    it("400s when there is nothing to claim or sweep", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });

      await expect(service.generate({ agentId: "a1" })).rejects.toBeInstanceOf(BadRequestException);
    });

    it("claims only accruals with positive drift, ignoring converged ones", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });
      models.commissionAccrual.findMany.mockResolvedValue([
        { id: "acc-open", payableAmount: 50, claimedAmount: 0, adjustments: [] },
        { id: "acc-converged", payableAmount: 30, claimedAmount: 30, adjustments: [] },
      ]);
      models.commissionStatement.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "s1", ...args.data }),
      );
      models.commissionStatement.findUnique.mockResolvedValue({ id: "s1", lines: [] });

      await service.generate({ agentId: "a1" });

      expect(models.commissionStatementLine.create).toHaveBeenCalledTimes(1);
      expect(models.commissionStatementLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            statementId: "s1",
            kind: "CLAIM",
            accrualId: "acc-open",
            amount: 50,
          }),
        }),
      );
      expect(models.commissionAccrual.update).toHaveBeenCalledWith({
        where: { id: "acc-open" },
        data: { claimedAmount: 50 },
      });
      expect(models.commissionStatement.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ totalAmount: 50, agentId: "a1" }),
        }),
      );
    });

    it("sweeps an unclaimed adjustment even on a zero-drift accrual", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });
      // How a converged clawback actually looks: 50 was claimed, payable then
      // dropped to 38, so the engine appended a -12 adjustment. Drift is now
      // 38 - 50 - (-12) = 0 — the adjustment is swept on its own, no CLAIM line.
      models.commissionAccrual.findMany.mockResolvedValue([
        {
          id: "acc1",
          payableAmount: 38,
          claimedAmount: 50,
          adjustments: [{ id: "adj1", kind: "CLAWBACK", amount: -12, line: null }],
        },
      ]);
      models.commissionStatement.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "s1", ...args.data }),
      );
      models.commissionStatement.findUnique.mockResolvedValue({ id: "s1", lines: [] });

      await service.generate({ agentId: "a1" });

      expect(models.commissionStatementLine.create).toHaveBeenCalledTimes(1);
      expect(models.commissionStatementLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ kind: "ADJUSTMENT", adjustmentId: "adj1", amount: -12 }),
        }),
      );
      // ADJUSTMENT lines never bump claimedAmount — only CLAIM lines do.
      expect(models.commissionAccrual.update).not.toHaveBeenCalled();
    });

    it("sweeps a prior negative-residual statement as one CARRYFORWARD line", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });
      models.commissionStatement.findMany.mockResolvedValue([
        {
          id: "prior1",
          statementNumber: "CST-2026-0001",
          totalAmount: -20,
          paidAmount: 0,
          carriedInto: [],
        },
      ]);
      models.commissionStatement.create.mockImplementation((args: any) =>
        Promise.resolve({ id: "s2", ...args.data }),
      );
      models.commissionStatement.findUnique.mockResolvedValue({ id: "s2", lines: [] });

      await service.generate({ agentId: "a1" });

      expect(models.commissionStatementLine.create).toHaveBeenCalledTimes(1);
      expect(models.commissionStatementLine.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: "CARRYFORWARD",
            carriedFromStatementId: "prior1",
            amount: -20,
          }),
        }),
      );
    });

    it("does not re-sweep a prior statement already carried into another line", async () => {
      models.salesAgent.findUnique.mockResolvedValue({ id: "a1" });
      models.commissionStatement.findMany.mockResolvedValue([
        {
          id: "prior1",
          statementNumber: "CST-2026-0001",
          totalAmount: -20,
          paidAmount: 0,
          carriedInto: [{ id: "line-already-there" }],
        },
      ]);

      await expect(service.generate({ agentId: "a1" })).rejects.toBeInstanceOf(BadRequestException);
      expect(models.commissionStatementLine.create).not.toHaveBeenCalled();
    });
  });

  describe("approve", () => {
    it("409s when a mid-flight clawback moved the accrual since generation", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        lines: [{ id: "l1", kind: "CLAIM", accrualId: "acc1", amount: 50 }],
      });
      // At generate time payable was 50 (fully claimed). A clawback since then
      // dropped payable to 30 with no offsetting adjustment recorded yet.
      models.commissionAccrual.findUnique.mockResolvedValue({
        id: "acc1",
        payableAmount: 30,
        claimedAmount: 50,
        adjustments: [],
      });

      await expect(service.approve("s1")).rejects.toBeInstanceOf(ConflictException);
      expect(models.commissionStatement.update).not.toHaveBeenCalled();
    });

    it("409s on the REAL clawback shape: payable drop WITH its compensating unclaimed adjustment", async () => {
      // The engine always writes the payable drop and the negative adjustment in
      // ONE transaction, so a naive expected-value check nets them to zero:
      // expected = payable(0) − priorClaimed(0) − adjTotal(−100) = 100 = line.
      // Without the unclaimed-adjustment guard this approves a $100 payout on a
      // fully-bounced invoice — commission on bad debt.
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        lines: [{ id: "l1", kind: "CLAIM", accrualId: "acc1", amount: 100 }],
      });
      models.commissionAccrual.findUnique.mockResolvedValue({
        id: "acc1",
        payableAmount: 0, // $1,000 invoice @10% — check bounced, payable zeroed
        claimedAmount: 100,
        adjustments: [{ id: "adj1", kind: "CLAWBACK", amount: -100, line: null }],
      });

      await expect(service.approve("s1")).rejects.toBeInstanceOf(ConflictException);
      expect(models.commissionStatement.update).not.toHaveBeenCalled();
    });

    it("409s when the statement is not PENDING", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        lines: [],
      });

      await expect(service.approve("s1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("approves and settles a fully-converged accrual", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        lines: [{ id: "l1", kind: "CLAIM", accrualId: "acc1", amount: 50 }],
      });
      models.commissionAccrual.findUnique.mockResolvedValue({
        id: "acc1",
        payableAmount: 50,
        claimedAmount: 50,
        adjustments: [],
      });

      await service.approve("s1");

      expect(models.commissionAccrual.update).toHaveBeenCalledWith({
        where: { id: "acc1" },
        data: { status: "SETTLED" },
      });
      expect(models.commissionStatement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "s1" },
          data: expect.objectContaining({ status: "APPROVED", approvedAt: expect.any(Date) }),
        }),
      );
    });
  });

  describe("voidStatement", () => {
    it("409s when the statement is not PENDING", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        lines: [],
      });

      await expect(service.voidStatement("s1")).rejects.toBeInstanceOf(ConflictException);
    });

    it("releases the claim back onto the accrual and deletes every line", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        lines: [{ id: "l1", kind: "CLAIM", accrualId: "acc1", amount: 50 }],
      });
      models.commissionAccrual.findUnique.mockResolvedValue({ id: "acc1", claimedAmount: 50 });

      await service.voidStatement("s1");

      expect(models.commissionAccrual.update).toHaveBeenCalledWith({
        where: { id: "acc1" },
        data: { claimedAmount: 0 },
      });
      expect(models.commissionStatementLine.delete).toHaveBeenCalledWith({ where: { id: "l1" } });
      expect(models.commissionStatement.update).toHaveBeenCalledWith({
        where: { id: "s1" },
        data: { status: "VOID" },
      });
    });
  });

  describe("recordPayout", () => {
    it("requires an APPROVED statement", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "PENDING",
        totalAmount: 100,
      });

      await expect(
        service.recordPayout("s1", { amount: 10, method: "ACH" as any }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("blocks payouts on a statement with no payable total", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        totalAmount: -20,
        statementNumber: "CST-2026-0001",
        agent: { name: "Jordan" },
      });

      await expect(
        service.recordPayout("s1", { amount: 10, method: "ACH" as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("rejects a payout that exceeds the ledger-derived remaining balance", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        totalAmount: 100,
        statementNumber: "CST-2026-0001",
        agent: { name: "Jordan" },
      });
      models.commissionPayout.findMany.mockResolvedValue([{ amount: 80 }]);

      await expect(
        service.recordPayout("s1", { amount: 30, method: "ACH" as any }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(models.commissionPayout.create).not.toHaveBeenCalled();
    });

    it("creates the linked COMMISSIONS_AND_FEES Expense and flips PAID at the cap", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        totalAmount: 100,
        statementNumber: "CST-2026-0001",
        agent: { name: "Jordan" },
      });
      models.commissionPayout.findMany.mockResolvedValue([]);
      const expenseCategoryModel = (prisma as any).expenseCategory;
      const expenseModel = (prisma as any).expense;
      expenseCategoryModel.findFirst.mockResolvedValue({
        id: "cat-1",
        code: "COMMISSIONS_AND_FEES",
      });
      expenseModel.create.mockResolvedValue({ id: "exp-1" });

      await service.recordPayout("s1", { amount: 100, method: "ACH" as any });

      expect(expenseModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ categoryId: "cat-1", amount: 100, status: "PAID" }),
        }),
      );
      expect(models.commissionPayout.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ expenseId: "exp-1", amount: 100, statementId: "s1" }),
        }),
      );
      expect(models.commissionStatement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "s1" },
          data: expect.objectContaining({ paidAmount: 100, status: "PAID" }),
        }),
      );
    });

    it("creates the ExpenseCategory on first use when it hasn't been seeded", async () => {
      models.commissionStatement.findUnique.mockResolvedValue({
        id: "s1",
        status: "APPROVED",
        totalAmount: 50,
        statementNumber: "CST-2026-0001",
        agent: { name: "Jordan" },
      });
      models.commissionPayout.findMany.mockResolvedValue([]);
      const expenseCategoryModel = (prisma as any).expenseCategory;
      const expenseModel = (prisma as any).expense;
      expenseCategoryModel.findFirst.mockResolvedValue(null);
      expenseCategoryModel.create.mockResolvedValue({ id: "cat-new" });
      expenseModel.create.mockResolvedValue({ id: "exp-2" });

      await service.recordPayout("s1", { amount: 20, method: "CASH" as any });

      expect(expenseCategoryModel.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ code: "COMMISSIONS_AND_FEES", isCustom: false }),
        }),
      );
      // Partial payout — statement stays APPROVED, not PAID.
      expect(models.commissionStatement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ paidAmount: 20, status: "APPROVED" }),
        }),
      );
    });
  });

  describe("listPayouts", () => {
    it("404s for an unknown statement", async () => {
      models.commissionStatement.findUnique.mockResolvedValue(null);
      await expect(service.listPayouts("missing")).rejects.toThrow();
    });
  });
});
