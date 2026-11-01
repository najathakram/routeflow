/**
 * SA-1078 (W-1096) PR-5, rows L1-L4, L8, L10: the customers list and its CSV show the customer's Open balance, the same
 * figure the statement sheet and the customer page show (`statementOutstandingAmount` over the clamped balance of every open
 * invoice). Replaces the D6 "Receivables" basis for these two surfaces (drafts behind an order and DRAFT payments used to
 * move it). Same mocked-Prisma harness as `customers.service.credit-exposure.spec.ts`. Dummy customers on `test`.
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
import { buildAccountStatement } from "./account-statement";

const CUSTOMER = {
  id: "cust-1",
  userId: "user-1",
  businessName: "Acme Corp",
  contactName: "John Doe",
  phone: "555-0100",
  zohoContactId: null,
  fulfillPath: "ROUTE" as const,
  customerType: "RETAIL",
  user: { status: "ACTIVE" },
  advancePayments: [] as { balance: number }[],
  createdAt: new Date(),
  updatedAt: new Date(),
};

const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
const inv = (
  customerId: string,
  status: string,
  total: number,
  payments: { amount: number; status: string }[] = [],
) => ({ customerId, status, total, dueDate: FUTURE, payments });

describe("CustomersService — Open balance on the list and the CSV (SA-1078 PR-5)", () => {
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
    service = module.get(CustomersService);
    prisma.customer.findMany.mockResolvedValue([CUSTOMER]);
    prisma.customer.count.mockResolvedValue(1);
    prisma.advancePayment.findMany.mockResolvedValue([]);
  });

  /** An invoice.findMany that applies the `where.status.notIn` the way the DB would. */
  const rows = (all: any[]) =>
    jest.fn((args: any = {}) => {
      const notIn: string[] = args?.where?.status?.notIn ?? [];
      return Promise.resolve(all.filter((r) => !notIn.includes(r.status)));
    });

  const listed = async () => {
    const res = await service.findAll({ page: 1, limit: 20 });
    return res.data[0] as any;
  };
  const csvTail = async () => (await service.exportCustomers({})).split("\n")[1];

  it("L1: $100 issued plus a $200 draft behind an order reads Open balance 100.00 (drafts are not owed)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([
        inv("cust-1", "SENT", 100),
        { ...inv("cust-1", "DRAFT", 200), order: { status: "DELIVERED" } },
      ]),
    );
    expect((await listed()).openBalance).toBe(100);
  });

  it("L2: $100 SENT with a $40 DRAFT payment reads 100.00 (an unconfirmed payment is not paid)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([inv("cust-1", "SENT", 100, [{ amount: 40, status: "DRAFT" }])]),
    );
    expect((await listed()).openBalance).toBe(100);
  });

  it("L3: an overpaid invoice does not net down another — $100 owed and $10 over reads 100.00", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([
        inv("cust-1", "SENT", 100),
        inv("cust-1", "SENT", 50, [{ amount: 60, status: "PAID" }]),
      ]),
    );
    expect((await listed()).openBalance).toBe(100);
  });

  it("a VOID payment does not count and a confirmed one does (balance, not total)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([
        inv("cust-1", "SENT", 100, [
          { amount: 100, status: "VOID" },
          { amount: 40, status: "PAID" },
        ]),
      ]),
    );
    expect((await listed()).openBalance).toBe(60);
  });

  it("the CSV Open Balance column also ignores a VOID payment (balance, not total)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([
        inv("cust-1", "SENT", 100, [
          { amount: 100, status: "VOID" },
          { amount: 25, status: "PAID" },
        ]),
      ]),
    );
    expect(await csvTail()).toContain(",75.00,0.00");
  });

  it("the sum is cents, never float dust (0.1 + 0.2 → 0.3)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([inv("cust-1", "SENT", 0.1), inv("cust-1", "SENT", 0.2)]),
    );
    expect((await listed()).openBalance).toBe(0.3);
  });

  it("L10: the wire key is openBalance, and the old receivables key is gone", async () => {
    prisma.invoice.findMany.mockImplementation(rows([inv("cust-1", "SENT", 100)]));
    const row = await listed();
    expect("openBalance" in row).toBe(true);
    expect("receivables" in row).toBe(false);
  });

  it("reads one invoice query for the whole page, with the statement's own where and select", async () => {
    prisma.invoice.findMany.mockImplementation(rows([inv("cust-1", "SENT", 100)]));
    await listed();
    expect(prisma.invoice.findMany).toHaveBeenCalledTimes(1);
    const args = prisma.invoice.findMany.mock.calls[0][0];
    expect(args.where.customerId).toEqual({ in: ["cust-1"] });
    // the EXACT set (order aside): a fifth status added to OPEN_BALANCE_INVOICE_WHERE must fail here, not pass
    expect([...args.where.status.notIn].sort()).toEqual(["DRAFT", "PAID", "VOID", "WRITTEN_OFF"]);
    expect(args.select).toEqual({
      customerId: true,
      total: true,
      status: true,
      dueDate: true,
      payments: { select: { amount: true, status: true } },
    });
  });

  it("two customers on one page are summed apart", async () => {
    prisma.customer.findMany.mockResolvedValue([CUSTOMER, { ...CUSTOMER, id: "cust-2" }]);
    prisma.customer.count.mockResolvedValue(2);
    prisma.invoice.findMany.mockImplementation(
      rows([inv("cust-1", "SENT", 100), inv("cust-2", "SENT", 70), inv("cust-1", "PARTIAL", 30)]),
    );
    const res = await service.findAll({ page: 1, limit: 20 });
    expect(res.data.map((c: any) => c.openBalance)).toEqual([130, 70]);
  });

  it("L4: the CSV column is 'Open Balance' and equals the list, for L1 to L3", async () => {
    const fixture = [
      inv("cust-1", "SENT", 100),
      { ...inv("cust-1", "DRAFT", 200), order: { status: "DELIVERED" } },
      inv("cust-1", "SENT", 100, [{ amount: 40, status: "DRAFT" }]),
      inv("cust-1", "SENT", 50, [{ amount: 60, status: "PAID" }]),
    ];
    prisma.invoice.findMany.mockImplementation(rows(fixture));
    const list = (await listed()).openBalance;
    const csv = await service.exportCustomers({});
    expect(csv.split("\n")[0]).toContain("Open Balance");
    expect(csv.split("\n")[0]).not.toContain("Receivables");
    expect(list).toBe(200);
    expect(await csvTail()).toContain(`,${list.toFixed(2)},0.00`);
  });

  it("a settled-to-the-cent invoice shows 0.00 in the CSV, never -0.00 (B584)", async () => {
    prisma.invoice.findMany.mockImplementation(
      rows([
        inv("cust-1", "SENT", 0.3, [
          { amount: 0.1, status: "PAID" },
          { amount: 0.2, status: "PAID" },
        ]),
      ]),
    );
    const tail = await csvTail();
    expect(tail).toContain(",0.00,0.00");
    expect(tail).not.toContain("-0.00");
  });

  it("L8: the list, the CSV and the account statement give one figure to the cent", async () => {
    const fixture = [
      inv("cust-1", "SENT", 100),
      inv("cust-1", "PARTIAL", 500, [{ amount: 200, status: "PAID" }]),
      inv("cust-1", "SENT", 500, [{ amount: 100, status: "PAID" }]),
      inv("cust-1", "SENT", 50, [{ amount: 60, status: "PAID" }]), // overpaid: adds 0
      inv("cust-1", "SENT", 100, [{ amount: 40, status: "DRAFT" }]),
    ];
    prisma.invoice.findMany.mockImplementation(rows(fixture));
    const list = (await listed()).openBalance;
    const csvFigure = Number((await csvTail()).split(",").slice(-2)[0]);

    // the statement builder reads the same invoices (full rows) + its other sources
    prisma.invoice.findMany.mockImplementation(
      rows(
        fixture.map((f, i) => ({
          ...f,
          id: `i${i}`,
          invoiceNumber: `INV-${i}`,
          issueDate: new Date("2026-10-01"),
          createdAt: new Date("2026-10-01"),
        })),
      ),
    );
    prisma.creditNote.findMany.mockResolvedValue([]);
    prisma.invoicePayment.findMany.mockResolvedValue([]);
    prisma.tenantConfig.findUnique.mockResolvedValue({ timezone: "UTC" });
    const statement = await buildAccountStatement(prisma as any, CUSTOMER, { staff: true });

    expect(list).toBe(statement.openBalance);
    expect(csvFigure).toBe(statement.openBalance);
  });
});
