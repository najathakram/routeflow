import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EmailService } from "../email/email.service";
import { createMockPrisma } from "../testing/prisma-mock";

// Extracted from customers.service.spec.ts (size ratchet — that file is at its
// baseline): sendPortalInvite's sentinel-email coverage lives here.
//
// Mirrors invoices.service.spec.ts: `@imported.local` / `@placeholder.local`
// sentinels are non-routable and must never become the invite recipient, from
// ANY of the three sources (override, customer.email, User login email).
describe("CustomersService.sendPortalInvite — sentinel emails", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

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

  const portalCustomer = (overrides: Record<string, unknown> = {}) => ({
    ...MOCK_CUSTOMER,
    email: null,
    user: { email: "no-email+x@placeholder.local" },
    ...overrides,
  });

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
        { provide: PrismaService, useValue: prisma },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue(null) } },
        {
          provide: CommissionEngineService,
          useValue: {
            syncInvoiceCommissionSafe: jest.fn(),
            syncOrderInvoices: jest.fn(),
            syncInvoiceCommission: jest.fn(),
          },
        },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
        { provide: MeterService, useValue: { read: jest.fn() } },
        {
          provide: PlanCatalogService,
          useValue: { getPublishedVersion: jest.fn().mockResolvedValue(null) },
        },
        { provide: EntitlementAuthority, useValue: { can: jest.fn().mockResolvedValue(false) } },
        {
          provide: RegulatedLedgerService,
          useValue: { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: EmailService,
          useValue: { send: jest.fn().mockResolvedValue({ delivered: true, transport: "resend" }) },
        },
      ],
    }).compile();
    service = module.get<CustomersService>(CustomersService);
  });

  it("refuses a sentinel-only customer as if no email exists (no invite written)", async () => {
    prisma.customer.findFirst.mockResolvedValue(
      portalCustomer({ email: "acme_store@imported.local" }) as any,
    );

    await expect(
      service.sendPortalInvite("cust-1", { method: "EMAIL" }, "tenant-1"),
    ).rejects.toThrow(/no email address/i);
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
  });

  it("refuses an @imported.local LOGIN email too (was only filtering @placeholder.local)", async () => {
    prisma.customer.findFirst.mockResolvedValue(
      portalCustomer({ user: { email: "acme_store@imported.local" } }) as any,
    );

    await expect(
      service.sendPortalInvite("cust-1", { method: "EMAIL" }, "tenant-1"),
    ).rejects.toThrow(/no email address/i);
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
  });

  it("filters sentinels case-insensitively (endsWith was case-sensitive)", async () => {
    prisma.customer.findFirst.mockResolvedValue(
      portalCustomer({ user: { email: "No-Email+X@PLACEHOLDER.LOCAL" } }) as any,
    );

    await expect(
      service.sendPortalInvite("cust-1", { method: "EMAIL" }, "tenant-1"),
    ).rejects.toThrow(/no email address/i);
  });

  it("refuses a sentinel override too (older clients echo the on-file address)", async () => {
    prisma.customer.findFirst.mockResolvedValue(portalCustomer() as any);

    await expect(
      service.sendPortalInvite(
        "cust-1",
        { method: "EMAIL", overrideEmail: "acme_store@imported.local" },
        "tenant-1",
      ),
    ).rejects.toThrow(/no email address/i);
    expect(prisma.customerLink.upsert).not.toHaveBeenCalled();
  });

  it("a real override wins over a sentinel on-file email", async () => {
    prisma.customer.findFirst.mockResolvedValue(
      portalCustomer({ email: "acme_store@imported.local" }) as any,
    );
    prisma.customerLink.upsert.mockResolvedValue({} as any);
    prisma.tenantConfig.findFirst.mockResolvedValue(null);

    const res = await service.sendPortalInvite(
      "cust-1",
      { method: "EMAIL", overrideEmail: "owner@acme.example" },
      "tenant-1",
    );

    expect(res.message).toContain("owner@acme.example");
    expect(prisma.customerLink.upsert).toHaveBeenCalled();
  });

  it("falls through sentinel customer.email to a REAL login email", async () => {
    prisma.customer.findFirst.mockResolvedValue(
      portalCustomer({
        email: "acme_store@imported.local",
        user: { email: "owner@acme.example" },
      }) as any,
    );
    prisma.customerLink.upsert.mockResolvedValue({} as any);
    prisma.tenantConfig.findFirst.mockResolvedValue(null);

    const res = await service.sendPortalInvite("cust-1", { method: "EMAIL" }, "tenant-1");

    expect(res.message).toContain("owner@acme.example");
  });
});
