/**
 * D6 / B462 (option B) — the operator statement's exposure figures (the customers list and CSV moved to
 * the statement's Open balance in SA-1078 PR-5; see `customers.service.open-balance.spec.ts`). Split out of `customers.service.spec.ts` so that file stays under the size ratchet
 * (`common/size-ratchet.spec.ts`); the harness is the same mocked-Prisma + stub-provider setup,
 * and `honouringTake` is copied verbatim. The derivation's own unit specs live in
 * `invoices/credit-exposure.spec.ts`.
 */

import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { computeCreditExposure, OPEN_ORDER_STATUSES } from "../invoices/credit-exposure";

const MOCK_CUSTOMER = {
  id: "cust-1",
  userId: "user-1",
  businessName: "Acme Corp",
  contactName: "John Doe",
  phone: "555-0100",
  zohoContactId: null,
  fulfillPath: "ROUTE" as const,
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("CustomersService — credit exposure (D6 / B462, option B)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        { provide: StorageService, useValue: {} },
        { provide: MeterService, useValue: {} },
        { provide: PlanCatalogService, useValue: {} },
        { provide: EntitlementAuthority, useValue: {} },
        { provide: CommissionEngineService, useValue: {} },
        { provide: RegulatedLedgerService, useValue: {} },
        { provide: EmailService, useValue: {} },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  /** A findMany mock that HONOURS `take`/`skip` AND the `where` status/balance
   * filters against a fixed row set (copied from customers.service.spec.ts): the list, CSV and
   * statement reads must see the rows the DB would return, not the whole fixture. */
  const honouringTake = (rows: any[]) =>
    jest.fn((args: any = {}) => {
      const where = args?.where ?? {};
      let matched = rows;
      if (where.status?.notIn) {
        matched = matched.filter((r: any) => !where.status.notIn.includes(r.status));
      }
      if (where.status?.not !== undefined) {
        matched = matched.filter((r: any) => r.status !== where.status.not);
      }
      if (where.balance?.gt !== undefined) {
        matched = matched.filter((r: any) => Number(r.balance) > where.balance.gt);
      }
      const skip = args?.skip ?? 0;
      const take = args?.take ?? matched.length;
      return Promise.resolve(matched.slice(skip, skip + take));
    });

  // ─── D6 / B462 (option B) — the statement
  // gains operator-only exposure figures from the SAME derivation the hard credit block uses.
  // A DRAFT whose order is OPEN or DELIVERED still counts by balance (delivered goods stay
  // guarded); a standalone / cancelled-order / draft-order DRAFT is pending, not counted.
  describe("D6 / B462 (option B) — statement exposure; list unusedCredits", () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

    it("findAll: unusedCredits is cents too (0.1 + 0.2 → 0.3)", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.advancePayment.findMany.mockResolvedValue([
        { customerId: "cust-1", balance: 0.1 },
        { customerId: "cust-1", balance: 0.2 },
      ]);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect((result.data[0] as any).unusedCredits).toBe(0.3);
    });

    describe("getStatementForOperator exposure figures", () => {
      const invoices = [
        {
          id: "inv-sent",
          invoiceNumber: "INV-1",
          orderId: null,
          total: 100,
          status: "SENT",
          dueDate: past,
          createdAt: new Date(),
          order: null,
          payments: [{ amount: 30, status: "PAID" }], // balance 70
        },
        {
          id: "inv-draft",
          invoiceNumber: "INV-2",
          orderId: null,
          total: 40,
          status: "DRAFT",
          dueDate: null,
          createdAt: new Date(),
          order: null, // standalone → unbacked → pending
          payments: [],
        },
      ];
      const openOrders = [
        { id: "ord-1", total: 25, orderNumber: "ORD-1", status: "PENDING", createdAt: past },
      ];

      beforeEach(() => {
        prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
        prisma.invoice.findMany.mockImplementation(honouringTake(invoices));
        prisma.creditNote.findMany.mockResolvedValue([]);
        prisma.advancePayment.findMany.mockResolvedValue([]);
        prisma.order.findMany.mockResolvedValue(openOrders);
      });

      it("the statement's pending-orders tile reads the SAME open-order set as the credit block (B584)", async () => {
        await service.getStatementForOperator("cust-1", { includeExposure: true });

        const openReads = prisma.order.findMany.mock.calls
          .map(([args]: [any]) => args?.where?.status?.in)
          .filter(Boolean);
        // the tile's own read AND the shared reader's read both use OPEN_ORDER_STATUSES
        expect(openReads.length).toBeGreaterThanOrEqual(2);
        for (const set of openReads) expect(new Set(set)).toEqual(new Set(OPEN_ORDER_STATUSES));
      });

      it("includeExposure: true returns creditExposure (issued balances + open orders) and pendingExposure (unbacked drafts)", async () => {
        const result: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        // counted = SENT balance 70 + uninvoiced open order 25; pending = standalone DRAFT 40.
        expect(result.creditExposure).toBe(95);
        expect(result.pendingExposure).toBe(40);
        // The DRAFT stays out of the existing receivable figure too (unchanged).
        expect(result.outstandingAmount).toBe(70);
      });

      it("option B: a DRAFT on a DELIVERED order counts in creditExposure (never pending); a CANCELLED-order DRAFT is pending", async () => {
        const rows = [
          ...invoices,
          {
            id: "inv-del",
            invoiceNumber: "INV-3",
            orderId: "ord-del",
            total: 90,
            status: "DRAFT",
            dueDate: null,
            createdAt: new Date(),
            order: { id: "ord-del", status: "DELIVERED", total: 90 },
            payments: [],
          },
          {
            id: "inv-can",
            invoiceNumber: "INV-4",
            orderId: "ord-can",
            total: 15,
            status: "DRAFT",
            dueDate: null,
            createdAt: new Date(),
            order: { id: "ord-can", status: "CANCELLED", total: 15 },
            payments: [],
          },
        ];
        prisma.invoice.findMany.mockImplementation(honouringTake(rows));

        const result: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        // counted = 70 (SENT) + 90 (delivered-order draft) + 25 (open order, no invoice) = 185;
        // pending = 40 (standalone) + 15 (cancelled-order draft) = 55.
        expect(result.creditExposure).toBe(185);
        expect(result.pendingExposure).toBe(55);
        // ...and it is exactly what the hard block's derivation computes from the same rows.
        const shared = computeCreditExposure({ invoices: rows as any, openOrders });
        expect(result.creditExposure).toBe(shared.counted);
        expect(result.pendingExposure).toBe(shared.pendingExposure);
      });

      it("option B: a partially invoiced open order counts max(order total, issued + draft) once in creditExposure", async () => {
        const o = { id: "ord-1", status: "PENDING", total: 100 };
        const rows = [
          { ...invoices[0], id: "inv-a", orderId: "ord-1", total: 60, payments: [], order: o },
          { ...invoices[1], id: "inv-b", orderId: "ord-1", total: 40, order: o }, // backed draft
        ];
        prisma.invoice.findMany.mockImplementation(honouringTake(rows));
        prisma.order.findMany.mockResolvedValue([{ ...openOrders[0], total: 100 }]);

        const result: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        expect(result.creditExposure).toBe(100); // not 200, not 60
        expect(result.pendingExposure).toBe(0);
      });

      it("the figures equal what the shared derivation (the credit block's) computes from the same rows", async () => {
        const result: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });
        const shared = computeCreditExposure({
          invoices: invoices as any,
          openOrders,
        });
        expect(result.creditExposure).toBe(shared.counted);
        expect(result.pendingExposure).toBe(shared.pendingExposure);
      });

      it("includeExposure omitted or false: the keys are ABSENT and no exposure reads are issued", async () => {
        const plain: any = await service.getStatementForOperator("cust-1");
        const explicitFalse: any = await service.getStatementForOperator("cust-1", {
          includeExposure: false,
        });

        for (const result of [plain, explicitFalse]) {
          expect(Object.keys(result)).not.toContain("creditExposure");
          expect(Object.keys(result)).not.toContain("pendingExposure");
        }
        // 2 calls x (open-set read + capped ledger read) = 4; the order read is 1 per call.
        expect(prisma.invoice.findMany).toHaveBeenCalledTimes(4);
        expect(prisma.order.findMany).toHaveBeenCalledTimes(2);
      });

      it("includeExposure adds ONLY the staff keys (creditExposure, pendingExposure, toCollect) + operator-only autoApplyCredit — every existing statement field is identical", async () => {
        const plain: any = await service.getStatementForOperator("cust-1");
        const withExposure: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        // SA-1026 A: toCollect is a staff key under includeExposure (the staff statement route's flag; the buyer route never sets it)
        const { creditExposure, pendingExposure, toCollect, autoApplyCredit, ...rest } =
          withExposure;
        expect(typeof autoApplyCredit).toBe("number");
        expect(typeof creditExposure).toBe("number");
        expect(typeof pendingExposure).toBe("number");
        expect(toCollect).toEqual({ count: expect.any(Number), balance: expect.any(Number) });
        expect(Object.keys(plain)).not.toContain("toCollect");
        expect(rest).toEqual(plain);
      });

      it("the exposure read is scoped to the requested customer and issues one invoice + one order read", async () => {
        await service.getStatementForOperator("cust-1", { includeExposure: true });

        // 2 statement invoice reads (open set + ledger) + 1 exposure read.
        expect(prisma.invoice.findMany).toHaveBeenCalledTimes(3);
        expect(prisma.order.findMany).toHaveBeenCalledTimes(2);
        const exposureRead = prisma.invoice.findMany.mock.calls
          .map((c: any[]) => c[0])
          .find((a: any) => a?.select?.orderId === true);
        expect(exposureRead.where.customerId).toBe("cust-1");
      });

      it("money figures are cents (0.1 + 0.2 → 0.3), never binary-float dust", async () => {
        prisma.invoice.findMany.mockImplementation(
          honouringTake([
            { ...invoices[0], total: 0.1, payments: [] },
            { ...invoices[0], id: "inv-sent-2", total: 0.2, payments: [] },
            { ...invoices[1], total: 0.1 },
            { ...invoices[1], id: "inv-draft-2", total: 0.2 },
          ]),
        );
        prisma.order.findMany.mockResolvedValue([]);

        const result: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        expect(result.creditExposure).toBe(0.3);
        expect(result.pendingExposure).toBe(0.3);
      });
    });
  });
});
