/**
 * #2569 (SA-510, tier 1): `deleteImportedCustomers` hard-deletes the invoices, payments, credit
 * notes and returns of every imported customer not linked to an ACTIVE account, and it had NO
 * invoice guard: it could destroy PAID invoices. It now runs the same guards as
 * `deleteAllCustomers` (customer-delete-preflight.ts): the pre-flight breakdown (a 409 naming the
 * blocked customers), the in-tx re-check and the compare-and-set invoice delete. It also refuses a
 * null tenant, where forTenant() is unscoped. Red-first.
 * Bootstrap copied from customers.service.delete-all.spec.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { ConflictException, ForbiddenException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";

describe("CustomersService.deleteImportedCustomers — invoice guard (#2569)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const SEEDED_CUSTOMERS = [
    { id: "cust-1", userId: "user-1", customerLink: null },
    { id: "cust-2", userId: "user-2", customerLink: { status: "PENDING" } },
    { id: "cust-3", userId: "user-3", customerLink: { status: "ACTIVE" } }, // preserved
  ];

  const blockOnStatus = (status: string, customerId: string, count: number) =>
    jest.fn(({ where }: any) => {
      const statuses: string[] = where?.status?.in ?? [];
      if (!statuses.includes(status)) return Promise.resolve([]);
      return Promise.resolve([{ customerId, _count: { _all: count } }]);
    });

  beforeEach(async () => {
    prisma = createMockPrisma();
    prisma.customer.findMany.mockResolvedValue(SEEDED_CUSTOMERS as any);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        // B65-class invariant: CustomersService now reverses a destroyed
        // invoice's regulated-ledger entries, so the collaborator must be provided.
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) },
        },
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
        {
          provide: MeterService,
          useValue: {
            read: jest.fn().mockResolvedValue({
              meter: "CUSTOMERS",
              used: 0,
              included: null,
              remaining: null,
              resetsAt: null,
            }),
          },
        },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241: EntitlementAuthority
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  const nothingDestroyed = () => {
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.deleteMany).not.toHaveBeenCalled();
    expect(prisma.creditNote.deleteMany).not.toHaveBeenCalled();
  };

  it.each(["PAID", "PARTIAL", "OVERDUE", "WRITTEN_OFF", "SENT", "VIEWED"])(
    "an imported customer with a %s invoice ⇒ refused with the blocked customer named, nothing deleted",
    async (status) => {
      (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus(status, "cust-2", 1));
      const caught: any = await service.runImportedCustomersCleanup().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("cust-2: 1 invoice(s)");
      nothingDestroyed();
    },
  );

  it("only the customers it would delete are checked (an ACTIVE-linked buyer is preserved, not a blocker)", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([]);
    prisma.invoice.deleteMany.mockResolvedValue({ count: 0 });
    await service.runImportedCustomersCleanup();
    expect((prisma.invoice.groupBy as jest.Mock).mock.calls[0][0].where.customerId).toEqual({
      in: ["cust-1", "cust-2"],
    });
  });

  it("DRAFT-only ⇒ proceeds, deleting exactly the invoices it read (a VOID blocks, SA-530)", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", customerId: "cust-1", status: "DRAFT" },
      { id: "inv-2", customerId: "cust-2", status: "DRAFT" },
    ]);
    prisma.invoice.deleteMany.mockResolvedValue({ count: 2 });
    const res = await service.runImportedCustomersCleanup();
    expect(res).toEqual({ deleted: 2, preserved: 1 });
    expect(prisma.invoice.deleteMany.mock.calls[0][0].where).toEqual({
      customerId: { in: ["cust-1", "cust-2"] },
      status: { notIn: ["SENT", "VIEWED", "PARTIAL", "PAID", "OVERDUE", "VOID", "WRITTEN_OFF"] },
    });
  });

  it("an invoice that turned PAID after the pre-flight ⇒ refused inside the tx, nothing deleted", async () => {
    (prisma.invoice.groupBy as jest.Mock).mockResolvedValue([]);
    prisma.invoice.findMany.mockResolvedValue([
      { id: "inv-1", customerId: "cust-1", status: "PAID" },
    ]);
    const caught: any = await service.runImportedCustomersCleanup().catch((e) => e);
    expect(caught).toBeInstanceOf(ConflictException);
    expect(caught.message).toContain("cust-1: 1 invoice(s)");
    expect(prisma.invoice.deleteMany).not.toHaveBeenCalled();
    expect(prisma.invoicePayment.deleteMany).not.toHaveBeenCalled();
  });

  it("a null tenant is refused before anything is read (no all-tenant wipe)", async () => {
    prisma.getTenantId.mockReturnValue(null);
    await expect(service.runImportedCustomersCleanup()).rejects.toThrow(ForbiddenException);
    expect(prisma.customer.findMany).not.toHaveBeenCalled();
    nothingDestroyed();
  });
});
