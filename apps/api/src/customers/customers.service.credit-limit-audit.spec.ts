import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { EmailService } from "../email/email.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { AuditService } from "../audit/audit.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("CustomersService.update credit limit: clear + audit old to new (B1018, SA-642)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn(),
            delete: jest.fn(),
            presignedUrl: jest.fn(),
          },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        { provide: PlanCatalogService, useValue: { getPublishedVersion: jest.fn() } },
        { provide: EntitlementsService, useValue: { hasFlag: jest.fn().mockResolvedValue(false) } },
        entitlementAuthorityFromEntitlements, // #2241
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn() },
        },
        { provide: EmailService, useValue: { send: jest.fn() } },
        { provide: AuditService, useValue: audit },
      ],
    }).compile();

    service = module.get(CustomersService);
  });

  const customer = (over: Record<string, unknown> = {}) => ({
    id: "cust-1",
    deletedAt: null,
    businessName: "Acme",
    contactName: "Jo",
    displayName: null,
    salutation: null,
    firstName: null,
    lastName: null,
    creditLimit: null as unknown,
    ...over,
  });
  const actor = { sub: "user-1", tenantId: "tenant-1", impersonatedBy: null };
  const written = () => prisma.customer.update.mock.calls[0][0].data;

  beforeEach(() => {
    prisma.customer.update.mockResolvedValue({ id: "cust-1" } as never);
    prisma.getTenantId.mockReturnValue("tenant-1");
  });
  const withExisting = (over: Record<string, unknown>) => {
    prisma.customer.findUnique.mockResolvedValue(customer(over));
    prisma.customer.findFirst.mockResolvedValue(customer(over));
  };

  it("null clears a stored limit: writes creditLimit null and ONE audit row {from, to: null}", async () => {
    withExisting({ creditLimit: "500.00" });
    await service.update("cust-1", { creditLimit: null } as never, undefined, actor);
    expect(written()).toHaveProperty("creditLimit", null);
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "user-1",
        action: "CUSTOMER_CREDIT_LIMIT_CHANGED",
        entityType: "customer",
        entityId: "cust-1",
        meta: { from: 500, to: null },
      }),
    );
  });

  it("setting a limit where there was none, and changing one, are audited old to new", async () => {
    withExisting({ creditLimit: null });
    await service.update("cust-1", { creditLimit: 750 } as never, undefined, actor);
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ meta: { from: null, to: 750 } }),
    );
    prisma.customer.update.mockClear();
    withExisting({ creditLimit: "750.00" });
    await service.update("cust-1", { creditLimit: 0 } as never, undefined, actor);
    expect(written()).toHaveProperty("creditLimit", 0); // 0 is a REAL $0 limit, not "no limit"
    expect(audit.log).toHaveBeenLastCalledWith(
      expect.objectContaining({ meta: { from: 750, to: 0 } }),
    );
  });

  it("no audit row when the limit is unchanged, omitted (undefined), or still blank", async () => {
    withExisting({ creditLimit: "500.00" });
    await service.update("cust-1", { creditLimit: 500 } as never, undefined, actor);
    await service.update("cust-1", { phone: "5551234567" } as never, undefined, actor);
    withExisting({ creditLimit: null });
    await service.update("cust-1", { creditLimit: null } as never, undefined, actor);
    expect(audit.log).not.toHaveBeenCalled();
  });

  it("an unrelated partial PATCH never writes creditLimit (no accidental clear)", async () => {
    withExisting({ creditLimit: "500.00" });
    await service.update("cust-1", { phone: "5551234567" } as never, undefined, actor);
    expect(written()).not.toHaveProperty("creditLimit");
  });

  it("the audit meta carries numbers only (never the customer's text), and a missing actor still audits with userId null", async () => {
    withExisting({ creditLimit: "10.00" });
    await service.update("cust-1", { creditLimit: 20 } as never);
    const arg = audit.log.mock.calls[0][0];
    expect(arg.userId).toBeNull();
    expect(Object.keys(arg.meta).sort()).toEqual(["from", "to"]);
  });
});
