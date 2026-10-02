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

describe("CustomersService person-name guards (B984)", () => {
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
    salutation: null,
    firstName: null,
    lastName: null,
    ...over,
  });
  const contact = (over: Record<string, unknown> = {}) => ({
    id: "cp-1",
    customerId: "cust-1",
    salutation: null,
    firstName: "Jo",
    lastName: "Lee",
    ...over,
  });
  const MSG = {
    salutation: "Salutation can't start with =, +, -, @ or a tab/line break",
    firstName: "First name can't start with =, +, -, @ or a tab/line break",
    lastName: "Last name can't start with =, +, -, @ or a tab/line break",
  } as const;

  describe("addContactPerson", () => {
    it.each(["salutation", "firstName", "lastName"] as const)(
      "refuses a formula-led %s with a readable coded 400 and writes nothing",
      async (field) => {
        prisma.customer.findUnique.mockResolvedValue(customer());
        prisma.customer.findFirst.mockResolvedValue(customer());
        const err = await service
          .addContactPerson("cust-1", { firstName: "Jo", [field]: "=HYPERLINK(1)" } as never)
          .catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
        expect(err.getResponse().message).toBe(MSG[field]);
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );

    it("phone, mobile and email are NOT guarded (a leading + is a legitimate phone number)", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          contactPerson: {
            updateMany: jest.fn(),
            create: jest.fn().mockResolvedValue({ id: "n" }),
          },
        }),
      );
      await expect(
        service.addContactPerson("cust-1", {
          firstName: "Jo",
          phone: "+1 555 0100",
          mobile: "+1 555 0101",
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe("updateContactPerson (change-only)", () => {
    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue(customer());
      prisma.customer.findFirst.mockResolvedValue(customer());
    });

    it("refuses a CHANGED formula-led lastName and writes nothing", async () => {
      prisma.contactPerson.findFirst.mockResolvedValue(contact());
      const err = await service
        .updateContactPerson("cust-1", "cp-1", { lastName: "@evil" } as never)
        .catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "lastName" });
      expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    });

    it("a LEGACY formula-led name echoed back unchanged does not block an unrelated edit", async () => {
      prisma.contactPerson.findFirst.mockResolvedValue(contact({ lastName: "=LEGACY" }));
      prisma.tenantTransaction.mockImplementation(async (fn: any) =>
        fn({
          contactPerson: {
            updateMany: jest.fn(),
            update: jest.fn().mockResolvedValue({ id: "cp-1" }),
          },
        }),
      );
      await expect(
        service.updateContactPerson("cust-1", "cp-1", {
          lastName: "=LEGACY",
          email: "a@b.co",
        } as never),
      ).resolves.toBeDefined();
    });
  });

  describe("create / update of the Customer's own salutation, firstName, lastName", () => {
    it.each(["salutation", "firstName", "lastName"] as const)(
      "create refuses a formula-led %s BEFORE any read or write",
      async (field) => {
        const err = await service
          .create({
            username: "acme",
            businessName: "Acme",
            contactName: "Jo",
            [field]: "+cmd",
          } as never)
          .catch((e) => e);
        expect(err).toBeInstanceOf(BadRequestException);
        expect(err.getResponse()).toMatchObject({ code: "TEXT_CELL_FORMULA_LEAD", field });
        expect(prisma.user.findFirst).not.toHaveBeenCalled();
        expect(prisma.tenantTransaction).not.toHaveBeenCalled();
      },
    );

    it("update refuses a CHANGED firstName but lets an unchanged legacy one through", async () => {
      prisma.customer.findUnique.mockResolvedValue(customer({ firstName: "=LEGACY" }));
      prisma.customer.findFirst.mockResolvedValue(customer({ firstName: "=LEGACY" }));
      const err = await service.update("cust-1", { firstName: "-new" } as never).catch((e) => e);
      expect(err).toBeInstanceOf(BadRequestException);
      expect(err.getResponse()).toMatchObject({ field: "firstName" });
    });
  });
});
