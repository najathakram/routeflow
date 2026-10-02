/**
 * B956: customer NAME fields (businessName / contactName / displayName) refuse a leading
 * = + - @ TAB CR LF on create and update. Existing rows are never touched; an UNCHANGED legacy value
 * does not block an unrelated edit. The check lives in customer-name-guard.ts (one shared function).
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

describe("CustomersService name guard (B956)", () => {
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

  const stored = (over: Record<string, unknown> = {}) => ({
    id: "cust-1",
    deletedAt: null,
    businessName: "Acme",
    contactName: "Jo",
    displayName: null,
    ...over,
  });

  describe("create", () => {
    it.each(["businessName", "contactName", "displayName"])(
      "refuses a formula-led %s with a readable 400 BEFORE any read or write",
      async (field) => {
        const dto = {
          username: "acme",
          businessName: "Acme",
          contactName: "Jo",
          [field]: "=HYPERLINK(1)",
        };
        const err = await service.create(dto as never).catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );
  });

  describe("update", () => {
    it("refuses a CHANGED formula-led name and writes nothing", async () => {
      prisma.customer.findUnique.mockResolvedValue(stored());
      const err = await service
        .update("cust-1", { contactName: "-2+3+cmd|' /C calc'!A0" })
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "contactName" });
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });

    it("a legacy formula-led name echoed back UNCHANGED does not block an unrelated edit", async () => {
      prisma.customer.findUnique.mockResolvedValue(stored({ businessName: "=LEGACY" }));
      prisma.customer.update.mockResolvedValue({});
      await expect(
        service.update("cust-1", { businessName: "=LEGACY", phone: "555" }),
      ).resolves.toBeDefined();
      expect(prisma.customer.update).toHaveBeenCalledTimes(1);
    });

    it("the stored row is the ONE read already made (no extra query, no rewrite of other rows)", async () => {
      prisma.customer.findUnique.mockResolvedValue(stored());
      prisma.customer.update.mockResolvedValue({});
      await service.update("cust-1", { phone: "555" });
      expect(prisma.customer.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.customer.findFirst).not.toHaveBeenCalled();
      expect(prisma.customer.updateMany).not.toHaveBeenCalled();
    });

    it("the buyer self-edit (updateMyProfile) goes through the same guard", async () => {
      prisma.customer.findFirst.mockResolvedValue(stored());
      prisma.customer.findUnique.mockResolvedValue(stored());
      await expect(
        service.updateMyProfile({ sub: "user-1" } as never, { displayName: "@evil" }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.customer.update).not.toHaveBeenCalled();
    });
  });
});
