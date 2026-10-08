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
import {
  SELF_SERVICE_FIELDS,
  pickSelfServiceFields,
  omitStaffOnlyCustomerFields,
} from "./self-service-fields";
import { BuyerController } from "../buyer/buyer.controller";
import { getMetadataStorage } from "class-validator";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { ValidationPipe } from "@nestjs/common";

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
    arrange();
    const controller = Object.create(BuyerController.prototype) as any;
    controller.customersService = service;
    await controller.updateMe({ customerId: "cust-1" }, { sub: "buyer-1" }, {
      contactName: "Jo B",
      ...SELLER_FIELDS,
    } as never);
    expect(prisma.customer.update).toHaveBeenCalledTimes(1);
    expect(prisma.customer.update.mock.calls[0][0].where).toEqual({ id: "cust-1" });
    expect(Object.keys(written()).sort()).toEqual(["contactName"]);
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

  // SA-653: customer `notes` is STAFF-INTERNAL, never self-writable; one list drives the DTO and the pick.
  const constraintsOf = (cls: new () => unknown, prop: string) =>
    getMetadataStorage()
      .getTargetValidationMetadatas(cls as never, "", false, false)
      .filter((m) => m.propertyName === prop)
      .map((m) => `${m.type}:${m.name ?? ""}`)
      .sort();

  it("(h) notes is not self-writable: not in the allowlist, dropped by both service layers, refused by the body pipe", async () => {
    expect(SELF_SERVICE_FIELDS).not.toContain("notes");
    arrange();
    await service.updateMyProfile(
      { sub: "user-1" } as never,
      { contactName: "Jo B", notes: "x" } as never,
    );
    expect(written()).not.toHaveProperty("notes");
    prisma.customer.update.mockClear();
    const controller = Object.create(BuyerController.prototype) as any;
    controller.customersService = service;
    await controller.updateMe({ customerId: "cust-1" }, { sub: "buyer-1" }, {
      contactName: "Jo B",
      notes: "x",
    } as never);
    expect(written()).not.toHaveProperty("notes");
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform({ notes: "x" }, { type: "body", metatype: UpdateBuyerProfileDto }),
    ).rejects.toBeDefined();
  });

  it("(i) UpdateBuyerProfileDto is DERIVED from UpdateCustomerDto: every field carries the staff DTO's validators", () => {
    for (const f of SELF_SERVICE_FIELDS) {
      expect(constraintsOf(UpdateBuyerProfileDto, f)).toEqual(constraintsOf(UpdateCustomerDto, f));
      expect(constraintsOf(UpdateBuyerProfileDto, f).length).toBeGreaterThan(0);
    }
  });

  it("(j) the buyer body pipe still accepts every allowlisted field", async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    const body = {
      contactName: "Jo",
      phone: "1",
      email: "jo@example.com",
      mobile: "2",
      salutation: "Mr",
      firstName: "Jo",
      lastName: "B",
      deliveryWindowStart: "08:00",
      deliveryWindowEnd: "12:00",
      orderStatusEmails: true,
    };
    expect(Object.keys(body).sort()).toEqual([...SELF_SERVICE_FIELDS].sort());
    await expect(
      pipe.transform(body, { type: "body", metatype: UpdateBuyerProfileDto }),
    ).resolves.toBeDefined();
  });

  // B1055 residual: a customer does not rename their own account record from the portal, and every
  // self-service profile change leaves an audit row.
  const NAME_FIELDS = ["businessName", "displayName"] as const;
  const auditCalls = () => prisma.auditLog.create.mock.calls.map((c: any[]) => c[0].data);

  it.each(NAME_FIELDS)(
    "(q) %s is not on the self-service allowlist and is dropped",
    async (field) => {
      expect(SELF_SERVICE_FIELDS).not.toContain(field);
      expect(pickSelfServiceFields({ phone: "1", [field]: "Renamed" } as never)).toEqual({
        phone: "1",
      });
      arrange();
      await service.updateMyProfile(
        { sub: "user-1" } as never,
        { contactName: "Jo B", [field]: "Renamed" } as never,
      );
      expect(written()).toMatchObject({ contactName: "Jo B" });
      expect(written()).not.toHaveProperty(field);
    },
  );

  it.each(NAME_FIELDS)("(r) the self-service body pipe refuses %s", async (field) => {
    const pipe = new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    });
    await expect(
      pipe.transform({ [field]: "Renamed" }, { type: "body", metatype: UpdateBuyerProfileDto }),
    ).rejects.toBeDefined();
  });

  it("(s) PATCH /customers/me writes one audit row naming the actor, the customer and the fields", async () => {
    arrange();
    await service.updateMyProfile(
      { sub: "user-1" } as never,
      { contactName: "Jo B", phone: "555-0100" } as never,
    );
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      tenantId: "test-tenant",
      userId: "user-1",
      entityType: "Customer",
      entityId: "cust-1",
      action: "customer.self_service.profile_update",
      meta: { source: "customers/me", fields: ["contactName", "phone"] },
    });
  });

  it("(t) PATCH /buyer/me writes the same audit row", async () => {
    arrange();
    const controller = Object.create(BuyerController.prototype) as any;
    controller.customersService = service;
    await controller.updateMe({ customerId: "cust-1" }, { sub: "buyer-1" }, {
      email: "jo@example.com",
    } as never);
    expect(auditCalls()).toHaveLength(1);
    expect(auditCalls()[0]).toMatchObject({
      userId: "buyer-1",
      entityId: "cust-1",
      action: "customer.self_service.profile_update",
      meta: { source: "buyer/me", fields: ["email"] },
    });
  });

  it("(u) the audit row records field names only, never the values", async () => {
    arrange();
    await service.updateMyProfile(
      { sub: "user-1" } as never,
      { phone: "555-0199", email: "private@example.com" } as never,
    );
    expect(JSON.stringify(auditCalls()[0])).not.toMatch(/555-0199|private@example\.com/);
  });

  it("(v) a refused edit writes no audit row, and an empty edit writes none either", async () => {
    prisma.customer.findFirst.mockResolvedValue(stored());
    prisma.customer.findUnique.mockResolvedValue(stored());
    await expect(
      service.updateMyProfile({ sub: "user-1" } as never, { contactName: "@evil" } as never),
    ).rejects.toBeDefined();
    arrange();
    await service.updateMyProfile({ sub: "user-1" } as never, { notes: "x" } as never);
    expect(prisma.auditLog.create).not.toHaveBeenCalled();
  });

  // Customer `notes` is staff-internal: no customer-facing customer response carries it.
  describe("customer-facing customer responses omit staff-only fields", () => {
    const row = () => ({ id: "cust-1", deletedAt: null, contactName: "Jo", notes: "internal" });

    it("(k) the helper drops notes without mutating its input", () => {
      const input = row();
      const out = omitStaffOnlyCustomerFields(input);
      expect(out).not.toHaveProperty("notes");
      expect(out.contactName).toBe("Jo");
      expect(input.notes).toBe("internal");
    });

    it("(l) GET /customers/me omits notes", async () => {
      prisma.customer.findFirst.mockResolvedValue(row());
      const res = await service.findMyProfile({ sub: "user-1" } as never);
      expect(res).not.toHaveProperty("notes");
      expect(res).toHaveProperty("contactName", "Jo");
    });

    it("(m) PATCH /customers/me omits notes", async () => {
      prisma.customer.findFirst.mockResolvedValue(row());
      prisma.customer.findUnique.mockResolvedValue(row());
      prisma.customer.update.mockResolvedValue(row());
      const res = await service.updateMyProfile(
        { sub: "user-1" } as never,
        {
          contactName: "Jo",
        } as never,
      );
      expect(res).not.toHaveProperty("notes");
    });

    it("(o) GET /customers/:id by the customer on its own id omits notes and staff tags", async () => {
      const full = {
        ...row(),
        userId: "user-1",
        tagAssignments: [{ tag: { name: "watch-list" } }],
      };
      prisma.customer.findUnique.mockResolvedValue(full);
      const res = await service.findOne("cust-1", { sub: "user-1", role: "CUSTOMER" } as never);
      expect(res).not.toHaveProperty("notes");
      expect(res).not.toHaveProperty("tagAssignments");
      expect(res).toHaveProperty("contactName", "Jo");
    });

    it("(p) GET /customers/:id by staff still returns notes and tags", async () => {
      const full = {
        ...row(),
        userId: "user-1",
        tagAssignments: [{ tag: { name: "watch-list" } }],
      };
      prisma.customer.findUnique.mockResolvedValue(full);
      const res = await service.findOne("cust-1", { sub: "staff-1", role: "OPERATOR" } as never);
      expect(res).toHaveProperty("notes", "internal");
      expect(res).toHaveProperty("tagAssignments");
    });

    it("(n) the buyer-portal profile handlers omit notes", async () => {
      const controller = Object.create(BuyerController.prototype) as any;
      controller.customersService = service;
      prisma.customer.findFirst.mockResolvedValue(row());
      prisma.customer.findUnique.mockResolvedValue(row());
      prisma.customer.update.mockResolvedValue(row());
      const ctx = { customerId: "cust-1", userId: "user-1", customer: row() };
      expect(controller.getProfile(ctx)).not.toHaveProperty("notes");
      expect(controller.getMe(ctx)).not.toHaveProperty("notes");
      expect(
        await controller.updateMe(ctx, { sub: "buyer-1" }, { contactName: "Jo" } as never),
      ).not.toHaveProperty("notes");
    });
  });
});
