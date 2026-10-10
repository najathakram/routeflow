/**
 * #2558: a customer delete never destroys an issued or paid invoice. Both pre-flights
 * (`batchDelete`, `deleteAllCustomers`) used to block on PAID/SENT only, so a customer whose open
 * invoices had been VIEWED, part-paid (PARTIAL) or marked OVERDUE (which #2556's sweep starts
 * persisting) passed the check; `deleteAllCustomers` then hard-deleted those invoices. SA-510: the
 * blocking set is every status EXCEPT DRAFT and VOID (WRITTEN_OFF blocks), defined by exclusion
 * from the Prisma enum so a future status blocks by default. Red-first.
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
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { EmailService } from "../email/email.service";
import { InvoiceStatus } from "@prisma/client";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";
import {
  CUSTOMER_DELETE_BLOCKING,
  CUSTOMER_DELETE_NON_BLOCKING,
} from "../invoices/invoice-status-sets";

describe("CustomersService — delete pre-flight blocks every issued or paid invoice (#2558)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  const SEEDED_CUSTOMERS = [
    { id: "cust-1", userId: "user-1" },
    { id: "cust-2", userId: "user-2" },
  ];

  /** Like a real groupBy: a blocker row only surfaces when the filter asks for its status. */
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
        entitlementAuthorityFromEntitlements, // #2241
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

  it.each(["OVERDUE", "PARTIAL", "VIEWED", "WRITTEN_OFF", "SENT", "PAID"])(
    "deleteAllCustomers: one %s invoice blocks the wipe, and nothing is deleted",
    async (status) => {
      (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus(status, "cust-2", 1));
      const caught: any = await service.deleteAllCustomers().catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("cust-2: 1 invoice(s)");
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    },
  );

  it.each(["OVERDUE", "PARTIAL", "VIEWED", "WRITTEN_OFF"])(
    "batchDelete: one %s invoice blocks the batch before any delete",
    async (status) => {
      (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus(status, "cust-1", 1));
      const del = jest.spyOn(service, "deleteCustomer");
      const caught: any = await service.batchDelete(["cust-1", "cust-2"]).catch((e) => e);
      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("cust-1: 1 invoice(s)");
      expect(del).not.toHaveBeenCalled();
    },
  );

  it("SA-510 / SA-530: the blocking set is the whole enum minus DRAFT (a new status blocks by default)", () => {
    const all = Object.values(InvoiceStatus).sort();
    expect([...CUSTOMER_DELETE_BLOCKING, ...CUSTOMER_DELETE_NON_BLOCKING].sort()).toEqual(all);
    expect([...CUSTOMER_DELETE_NON_BLOCKING]).toEqual(["DRAFT"]);
    expect(CUSTOMER_DELETE_BLOCKING).toContain("WRITTEN_OFF");
    expect(CUSTOMER_DELETE_BLOCKING).toContain("VOID"); // #2628 / SA-530 (owner policy 4b)
    expect(new Set(CUSTOMER_DELETE_BLOCKING).size).toBe(CUSTOMER_DELETE_BLOCKING.length);
  });

  it.each(["DRAFT"])(
    "no over-correction: a %s invoice alone does not block (deleteAllCustomers still runs)",
    async (status) => {
      (prisma.invoice.groupBy as jest.Mock).mockImplementation(blockOnStatus(status, "cust-1", 1));
      const res = await service.deleteAllCustomers();
      expect(res).toEqual({ deleted: SEEDED_CUSTOMERS.length });
      expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    },
  );
});
