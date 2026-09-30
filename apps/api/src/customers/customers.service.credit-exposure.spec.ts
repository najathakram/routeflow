/**
 * D6 / B462 (option B) — customers list / CSV receivables and the operator statement's exposure
 * figures. Split out of `customers.service.spec.ts` so that file stays under the size ratchet
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
import { CREDIT_NOT_APPLICABLE } from "../invoices/invoice-status-sets";
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

  // ─── D6 / B462 (option B) — only UNBACKED drafts leave the receivables basis; the statement
  // gains operator-only exposure figures from the SAME derivation the hard credit block uses.
  // A DRAFT whose order is OPEN or DELIVERED still counts by balance (delivered goods stay
  // guarded); a standalone / cancelled-order / draft-order DRAFT is not a receivable. The
  // DRAFT-PAYMENT basis (non-VOID payments) is a separate open decision and stays.
  describe("D6 / B462 (option B) — only unbacked DRAFT invoices excluded from list/CSV receivables; statement exposure", () => {
    const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    const orderOf = (status: string) => ({ status });

    // One fixture, every shape, worked out by hand:
    //   SENT 100 (no order)                          → 100  counted by balance
    //   DRAFT 900 standalone (no order)              → skipped (unbacked)
    //   DRAFT 700 on a CANCELLED order               → skipped (unbacked)
    //   DRAFT 600 on a DRAFT-status order            → skipped (unbacked)
    //   DRAFT 300 on a DELIVERED order               → 300  counted (backed)
    //   DRAFT 50 on an OPEN (CONFIRMED) order        →  50  counted (backed)
    //   PAID 500                                     → dropped by the settled filter
    const fixture = () => [
      { customerId: "cust-1", status: "SENT", total: 100, order: null, payments: [] },
      { customerId: "cust-1", status: "DRAFT", total: 900, order: null, payments: [] },
      {
        customerId: "cust-1",
        status: "DRAFT",
        total: 700,
        order: orderOf("CANCELLED"),
        payments: [],
      },
      { customerId: "cust-1", status: "DRAFT", total: 600, order: orderOf("DRAFT"), payments: [] },
      {
        customerId: "cust-1",
        status: "DRAFT",
        total: 300,
        order: orderOf("DELIVERED"),
        payments: [],
      },
      {
        customerId: "cust-1",
        status: "DRAFT",
        total: 50,
        order: orderOf("CONFIRMED"),
        payments: [],
      },
      { customerId: "cust-1", status: "PAID", total: 500, order: null, payments: [] },
    ];

    it("findAll: reads non-settled invoices INCLUDING drafts (each with its order status) and drops ONLY unbacked drafts from receivables", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(honouringTake(fixture()));

      const result = await service.findAll({ page: 1, limit: 20 });

      // 100 + 300 (delivered-order draft) + 50 (open-order draft) — not 2,650 and not 100.
      expect((result.data[0] as any).receivables).toBe(450);
      const args = prisma.invoice.findMany.mock.calls[0][0];
      // Settled only in SQL: DRAFT must come back so the JS predicate can judge its order.
      expect(new Set(args.where.status.notIn)).toEqual(new Set(CREDIT_NOT_APPLICABLE));
      expect(args.where.status.notIn).not.toContain("DRAFT");
      expect(args.select.status).toBe(true);
      expect(args.select.order).toEqual({ select: { status: true } });
    });

    it("findAll: a customer whose only invoice is an unbacked DRAFT shows 0 receivables", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          { customerId: "cust-1", status: "DRAFT", total: 900, order: null, payments: [] },
        ]),
      );

      const result = await service.findAll({ page: 1, limit: 20 });

      expect((result.data[0] as any).receivables).toBe(0);
    });

    it("findAll: the payment basis is UNCHANGED — non-VOID payments (incl. a DRAFT payment) still net off", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          {
            customerId: "cust-1",
            status: "SENT",
            total: 100,
            order: null,
            payments: [
              { amount: 100, status: "VOID" }, // bounced — ignored
              { amount: 25, status: "DRAFT" }, // still counted as paid (tracked follow-up)
            ],
          },
        ]),
      );

      const result = await service.findAll({ page: 1, limit: 20 });

      expect((result.data[0] as any).receivables).toBe(75);
    });

    it("findAll: a BACKED draft nets its payments like any invoice (balance, not total)", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          {
            customerId: "cust-1",
            status: "DRAFT",
            total: 300,
            order: orderOf("DELIVERED"),
            payments: [{ amount: 120, status: "PAID" }],
          },
        ]),
      );

      const result = await service.findAll({ page: 1, limit: 20 });

      expect((result.data[0] as any).receivables).toBe(180);
    });

    it("findAll: the summed receivable is cents, never binary-float dust (0.1 + 0.2 → 0.3)", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          { customerId: "cust-1", status: "SENT", total: 0.1, order: null, payments: [] },
          { customerId: "cust-1", status: "SENT", total: 0.2, order: null, payments: [] },
        ]),
      );

      const result = await service.findAll({ page: 1, limit: 20 });

      // 0.1 + 0.2 === 0.30000000000000004 in binary floating point.
      expect((result.data[0] as any).receivables).toBe(0.3);
    });

    it("exportCustomers: the nested invoice read keeps drafts; the CSV Receivables column drops ONLY unbacked drafts", async () => {
      // A findMany that APPLIES the nested `include.invoices.where` to the fixture, so the CSV
      // total below proves which invoices reach the sum (PAID dropped in SQL, unbacked drafts in JS).
      prisma.customer.findMany.mockImplementation((args: any) => {
        const notIn: string[] = args.include.invoices.where.status.notIn;
        return Promise.resolve([
          {
            ...MOCK_CUSTOMER,
            customerType: "RETAIL",
            user: { status: "ACTIVE" },
            invoices: fixture()
              .map((i, idx) =>
                idx === 0 ? { ...i, payments: [{ amount: 25, status: "PAID" }] } : i,
              )
              .filter((i) => !notIn.includes(i.status)),
            advancePayments: [],
          },
        ]);
      });

      const csv = await service.exportCustomers({});

      // (100 − 25) + 300 + 50 = 425; the 900 / 700 / 600 unbacked drafts are dropped.
      expect(csv.split("\n")[1]).toContain(",425.00,0.00");
      const args = prisma.customer.findMany.mock.calls[0][0];
      expect(new Set(args.include.invoices.where.status.notIn)).toEqual(
        new Set(CREDIT_NOT_APPLICABLE),
      );
      expect(args.include.invoices.select.status).toBe(true);
      expect(args.include.invoices.select.order).toEqual({ select: { status: true } });
    });

    it("the list and the CSV agree on one customer's receivables (one basis)", async () => {
      prisma.customer.findMany.mockImplementation((args: any) => {
        if (args.include?.invoices) {
          const notIn: string[] = args.include.invoices.where.status.notIn;
          return Promise.resolve([
            {
              ...MOCK_CUSTOMER,
              customerType: "RETAIL",
              user: { status: "ACTIVE" },
              invoices: fixture().filter((i) => !notIn.includes(i.status)),
              advancePayments: [],
            },
          ]);
        }
        return Promise.resolve([MOCK_CUSTOMER]);
      });
      prisma.customer.count.mockResolvedValue(1);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.invoice.findMany.mockImplementation(honouringTake(fixture()));

      const list = await service.findAll({ page: 1, limit: 20 });
      const csv = await service.exportCustomers({});

      const listed = (list.data[0] as any).receivables;
      expect(csv.split("\n")[1]).toContain(`,${listed.toFixed(2)},0.00`);
      expect(listed).toBe(450);
    });

    it("exportCustomers: a settled-to-the-cent invoice shows 0.00, never -0.00 float dust (B584)", async () => {
      prisma.customer.findMany.mockImplementation((args: any) => {
        const notIn: string[] = args.include.invoices.where.status.notIn;
        return Promise.resolve([
          {
            ...MOCK_CUSTOMER,
            customerType: "RETAIL",
            user: { status: "ACTIVE" },
            invoices: [
              {
                status: "SENT",
                total: 0.3,
                order: null,
                // 0.3 − (0.1 + 0.2) === −5.55e-17 in binary floating point → "-0.00" via toFixed
                payments: [
                  { amount: 0.1, status: "PAID" },
                  { amount: 0.2, status: "PAID" },
                ],
              },
            ].filter((i) => !notIn.includes(i.status)),
            advancePayments: [],
          },
        ]);
      });

      const csv = await service.exportCustomers({});

      expect(csv.split("\n")[1]).toContain(",0.00,0.00");
      expect(csv.split("\n")[1]).not.toContain("-0.00");
    });

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

      it("includeExposure adds ONLY the two keys — every existing statement field is identical", async () => {
        const plain: any = await service.getStatementForOperator("cust-1");
        const withExposure: any = await service.getStatementForOperator("cust-1", {
          includeExposure: true,
        });

        const { creditExposure, pendingExposure, ...rest } = withExposure;
        expect(typeof creditExposure).toBe("number");
        expect(typeof pendingExposure).toBe("number");
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
