/**
 * The customer self-service profile edit (PATCH /customers/me) accepts only the customer's own contact
 * fields. The seller-controlled commercial fields (tax status, price tier, credit, payment terms, deposit
 * default and the like) are never writable from that route: the controller takes the same narrow body type
 * as PATCH /buyer/me, and updateMyProfile applies an explicit allowlist before the shared update().
 */
import "reflect-metadata";
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
import { createMockPrisma } from "../testing/prisma-mock";
import { entitlementAuthorityFromEntitlements } from "../testing/entitlement-authority-provider";

import { CustomersController } from "./customers.controller";
import { UpdateBuyerProfileDto } from "../buyer/dto/update-buyer-profile.dto";
import { SELF_SERVICE_FIELDS, pickSelfServiceFields } from "./self-service-fields";
import { BuyerController } from "../buyer/buyer.controller";
import { getMetadataStorage } from "class-validator";

describe("customer self-service profile edit keeps seller-controlled fields out", () => {
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

  const stored = () => ({ id: "cust-1", deletedAt: null, businessName: "Acme", contactName: "Jo" });
  const arrange = () => {
    prisma.customer.findFirst.mockResolvedValue(stored());
    prisma.customer.findUnique.mockResolvedValue(stored());
    prisma.customer.update.mockResolvedValue(stored());
  };
  const written = () => prisma.customer.update.mock.calls[0]?.[0]?.data ?? {};
  const SELLER_FIELDS = {
    isTaxExempt: true,
    pricingTier: 1,
    creditLimit: 999999,
    defaultPaymentTerms: "Net 90",
    defaultDepositPercent: 0,
    taxId: "X-1",
    currency: "EUR",
    customerType: "wholesale",
    fulfillPath: "PICKUP",
  };

  it("(a) the PATCH /customers/me handler takes the narrow buyer-profile body type, not the staff update type", () => {
    const types = Reflect.getMetadata(
      "design:paramtypes",
      CustomersController.prototype,
      "updateMyProfile",
    );
    expect(types[1]).toBe(UpdateBuyerProfileDto);
  });

  it.each(Object.keys(SELLER_FIELDS))(
    "(b) %s sent through updateMyProfile never reaches the write",
    async (field) => {
      arrange();
      await service.updateMyProfile(
        { sub: "user-1" } as never,
        {
          contactName: "Jo B",
          [field]: (SELLER_FIELDS as Record<string, unknown>)[field],
        } as never,
      );
      expect(written()).toMatchObject({ contactName: "Jo B" });
      expect(written()).not.toHaveProperty(field);
    },
  );

  it("(c) every seller-controlled field at once: only the contact field is written", async () => {
    arrange();
    await service.updateMyProfile(
      { sub: "user-1" } as never,
      {
        contactName: "Jo B",
        ...SELLER_FIELDS,
      } as never,
    );
    expect(Object.keys(written()).sort()).toEqual(["contactName"]);
  });

  it("(d) the customer's own contact fields still work", async () => {
    arrange();
    await service.updateMyProfile(
      { sub: "user-1" } as never,
      {
        contactName: "Jo B",
        phone: "555-0100",
        mobile: "555-0101",
        email: "jo@example.com",
        deliveryWindowStart: "08:00",
        deliveryWindowEnd: "12:00",
        orderStatusEmails: false,
      } as never,
    );
    expect(written()).toMatchObject({
      contactName: "Jo B",
      phone: "555-0100",
      mobile: "555-0101",
      email: "jo@example.com",
      deliveryWindowStart: "08:00",
      deliveryWindowEnd: "12:00",
      orderStatusEmails: false,
    });
  });

  it("(e) the allowlist names no seller-controlled field, and pickSelfServiceFields drops unknown keys", () => {
    for (const f of Object.keys(SELLER_FIELDS)) expect(SELF_SERVICE_FIELDS).not.toContain(f);
    expect(pickSelfServiceFields({ phone: "1", whatever: 2, userId: "u" } as never)).toEqual({
      phone: "1",
    });
  });

  it("(f) the buyer-portal handler (PATCH /buyer/me) applies the SAME allowlist before the shared update", async () => {
    const update = jest.fn().mockResolvedValue({});
    const controller = Object.create(BuyerController.prototype) as any;
    controller.customersService = { update };
    await controller.updateMe({ customerId: "cust-1" }, {
      contactName: "Jo B",
      ...SELLER_FIELDS,
    } as never);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0]).toBe("cust-1");
    expect(Object.keys(update.mock.calls[0][1]).sort()).toEqual(["contactName"]);
  });

  it("(g) the allowlist is set-equal to the fields UpdateBuyerProfileDto declares (no hand-copy drift)", () => {
    const declared = [
      ...new Set(
        getMetadataStorage()
          .getTargetValidationMetadatas(UpdateBuyerProfileDto, "", false, false)
          .map((m) => m.propertyName),
      ),
    ].sort();
    expect([...SELF_SERVICE_FIELDS].sort()).toEqual(declared);
  });
});
