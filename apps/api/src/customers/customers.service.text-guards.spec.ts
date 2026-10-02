/**
 * B964-1: customer ADDRESS fields (label/line1/line2/city/state/zip) and the importer-only tobaccoLicenseNo refuse a leading
 * = + - @ TAB CR LF on create, addAddress, updateAddress and update. Existing rows are never touched; an UNCHANGED legacy value
 * does not block an unrelated edit (change-only, the B956 rule). The checks live in common/text-cell-guards.ts.
 */
import { Test, TestingModule } from "@nestjs/testing";
import { BadRequestException } from "@nestjs/common";
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
import { createMockPrisma } from "../testing/prisma-mock";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

describe("CustomersService address + license guards (B964-1)", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(async () => {
    prisma = createMockPrisma();
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
    tobaccoLicenseNo: null,
    ...over,
  });
  const address = (over: Record<string, unknown> = {}) => ({
    label: "Main",
    line1: "12 Main St",
    city: "Austin",
    state: "TX",
    zip: "78701",
    ...over,
  });

  describe("create (addresses[])", () => {
    it.each(["label", "line1", "line2", "city", "state", "zip"])(
      "refuses a formula-led address %s with a readable 400 BEFORE any read or write",
      async (field) => {
        const dto = {
          username: "acme",
          businessName: "Acme",
          contactName: "Jo",
          addresses: [address(), address({ [field]: "=HYPERLINK(1)" })],
        };
        const err = await service.create(dto as never).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );
  });

  describe("addAddress", () => {
    it("refuses a formula-led city: nothing is geocoded or written", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
      const err = await service
        .addAddress("cust-1", address({ city: "-Springfield" }) as never)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "city" });
      expect(err.getResponse().message).toBe(
        "City can't start with =, +, -, @ or a tab/line break",
      );
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });
    it("accepts ZIP+4 and a numeric-only ZIP", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
      await expect(
        service.addAddress("cust-1", address({ zip: "78701-1234" }) as never),
      ).resolves.not.toBeUndefined();
    });
  });

  describe("updateAddress", () => {
    it("refuses a CHANGED formula-led line1 before the transaction", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
      prisma.customerAddress.findFirst.mockResolvedValue(
        address({ line1: "OLD", stateCode: "TX" }),
      );
      const err = await service
        .updateAddress("cust-1", "addr-1", { line1: "=cmd|' /C calc'!A0" } as never)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "line1" });
      expect(prisma.customerAddress.update).not.toHaveBeenCalled();
    });
    it("a LEGACY formula-led stored value echoed back unchanged does not block the edit", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
      prisma.customerAddress.findFirst.mockResolvedValue(
        address({ line1: "=LEGACY", stateCode: "TX" }),
      );
      prisma.customerAddress.update.mockResolvedValue({ id: "addr-1" });
      await expect(
        service.updateAddress("cust-1", "addr-1", { line1: "=LEGACY", city: "Dallas" } as never),
      ).resolves.not.toBeUndefined();
    });
  });

  describe("update (importer compliance: tobaccoLicenseNo)", () => {
    it("refuses a CHANGED formula-led license number and writes nothing", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      const err = await service
        .update("cust-1", {}, { compliance: { tobaccoLicenseNo: "=1+1" } })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "tobaccoLicenseNo" });
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });
    it("a legacy value echoed back, or a normal license, passes", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer({ tobaccoLicenseNo: "=OLD" }));
      prisma.customer.update.mockResolvedValue({});
      await expect(
        service.update("cust-1", {}, { compliance: { tobaccoLicenseNo: "=OLD" } }),
      ).resolves.toBeDefined();
      await expect(
        service.update("cust-1", {}, { compliance: { tobaccoLicenseNo: "TX-123456" } }),
      ).resolves.toBeDefined();
    });
  });
});
