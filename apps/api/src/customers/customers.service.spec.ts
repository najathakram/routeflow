import { Test, TestingModule } from "@nestjs/testing";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import {
  NotFoundException,
  ForbiddenException,
  BadRequestException,
  ConflictException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";
import { CreateCustomerDto } from "./dto/create-customer.dto";
import { UpdateCustomerDto } from "./dto/update-customer.dto";
import { withAdvisoryLock as mockedWithAdvisoryLock } from "../common/db-locks";

// B310: a real advisory lock serializes concurrent callers sharing a key on a dedicated
// Postgres connection (see db-locks.db.spec.ts for that primitive's own coverage). A plain
// unit test has no live DB, so this stand-in reproduces the one property the fix depends on —
// concurrent callers sharing a `(family, key)` run their critical section ONE AT A TIME, in
// call order — via a per-key promise chain, so the race this bug fixes stays reproducible here.
jest.mock("../common/db-locks", () => {
  class LockTimeoutError extends Error {
    constructor(
      public family: string,
      public key: string,
      public waitMs: number,
    ) {
      super(`advisory lock ${family}:${key} not acquired within ${waitMs}ms`);
      this.name = "LockTimeoutError";
    }
  }
  class LockUnavailableError extends Error {
    constructor(public cause?: unknown) {
      super("advisory lock connection unavailable");
      this.name = "LockUnavailableError";
    }
  }
  const chains = new Map<string, Promise<unknown>>();
  const withAdvisoryLock = jest.fn((opts: any, fn: () => Promise<any>) => {
    const lockKey = `${opts.family}:${opts.key}`;
    const prior = chains.get(lockKey) ?? Promise.resolve();
    const turn = prior.then(fn, fn);
    chains.set(
      lockKey,
      turn.catch(() => undefined),
    );
    return turn.then((value) => ({ acquired: true, value }));
  });
  return { withAdvisoryLock, LockTimeoutError, LockUnavailableError };
});

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

const operatorPayload = {
  sub: "user-op",
  username: "operator",
  role: "OPERATOR" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

const customerPayload = {
  sub: "user-1",
  username: "customer",
  role: "CUSTOMER" as const,
  status: "ACTIVE" as const,
  forcePasswordChange: false,
};

describe("CustomersService", () => {
  let service: CustomersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let meter: { read: jest.Mock };
  let catalog: { getPublishedVersion: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let configGet: jest.Mock;
  let ledger: { reverseInvoiceEntries: jest.Mock };
  const originalFetch = global.fetch;

  beforeEach(async () => {
    prisma = createMockPrisma();
    ledger = { reverseInvoiceEntries: jest.fn().mockResolvedValue(undefined) };
    // Defaults to "no key configured" so geocoding is a no-op (returns null without
    // calling fetch) for every pre-existing test — narrow it per-test to exercise
    // the geocode-on-create paths below.
    configGet = jest.fn().mockReturnValue(null);
    // createMockPrisma()'s model list predates the CUSTOMERS soft-cap (WP3) and
    // doesn't carry tenantSubscription; attach it here rather than editing the
    // shared mock (out of this package's file scope).
    (prisma as any).tenantSubscription = {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
    };

    // Defaults to "unlimited" so the pre-existing create() tests (which predate
    // the CUSTOMERS soft-cap) are unaffected — the cap gate is a no-op unless a
    // test below explicitly narrows it.
    meter = {
      read: jest.fn().mockResolvedValue({
        meter: "CUSTOMERS",
        used: 0,
        included: null,
        remaining: null,
        resetsAt: null,
      }),
    };
    catalog = { getPublishedVersion: jest.fn().mockResolvedValue(null) };
    // flag.msrp defaults OFF — msrp-free upserts never consult the flag. Hoisted
    // (rather than inlined in the provider) so a test that DOES carry `msrp` can
    // flip the flag ON and let assertMsrpAllowed return quietly; the stub catalog
    // has no upgradeTargetForFlag, so a flag-OFF msrp path would crash there and
    // mask the behaviour the test is actually about.
    entitlements = { hasFlag: jest.fn().mockResolvedValue(false) };

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
        { provide: ConfigService, useValue: { get: configGet } },
        {
          provide: StorageService,
          useValue: {
            upload: jest.fn().mockResolvedValue("mock-key"),
            delete: jest.fn().mockResolvedValue(undefined),
            presignedUrl: jest.fn().mockResolvedValue("https://mock-url"),
          },
        },
        { provide: MeterService, useValue: meter },
        { provide: PlanCatalogService, useValue: catalog },
        { provide: EntitlementsService, useValue: entitlements },
        { provide: RegulatedLedgerService, useValue: ledger },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  // ─── findAll ──────────────────────────────────────────────────────────────

  describe("findAll", () => {
    it("should return paginated customers", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect(result.data).toHaveLength(1);
      expect(result.meta.total).toBe(1);
      expect(result.meta.totalPages).toBe(1);
    });

    it("should apply search across businessName, contactName, and phone", async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.findAll({ search: "acme", page: 1, limit: 20 });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              { businessName: expect.any(Object) },
              { contactName: expect.any(Object) },
              { phone: expect.any(Object) },
            ]),
          }),
        }),
      );
    });

    it("should calculate correct totalPages", async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(45);

      const result = await service.findAll({ page: 1, limit: 20 });
      expect(result.meta.totalPages).toBe(3);
    });

    it('applies the "sells regulated items" filter via the authorizations relation', async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.findAll({ regulated: "1", page: 1, limit: 20 });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            authorizations: { some: { trackedCategory: { requiresLicense: true } } },
          }),
        }),
      );
    });

    it('omits the regulated filter when "regulated" is not exactly "1"', async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);

      await service.findAll({ regulated: "0", page: 1, limit: 20 });

      expect(prisma.customer.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.not.objectContaining({
            authorizations: expect.anything(),
          }),
        }),
      );
    });

    it("surfaces a per-row regulatedCount from the filtered _count projection", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { ...MOCK_CUSTOMER, _count: { authorizations: 2 } },
      ]);
      prisma.customer.count.mockResolvedValue(1);

      const result = await service.findAll({ page: 1, limit: 20 });

      expect((result.data[0] as any).regulatedCount).toBe(2);
    });
  });

  // ─── findOne ──────────────────────────────────────────────────────────────

  describe("findOne", () => {
    it("should return customer for operators", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      const result = await service.findOne("cust-1", operatorPayload);
      expect(result).toEqual(MOCK_CUSTOMER);
    });

    it("should return customer when the authenticated customer owns the record", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      const result = await service.findOne("cust-1", customerPayload);
      expect(result).toEqual(MOCK_CUSTOMER);
    });

    it("should throw ForbiddenException when a different customer tries to access", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      const otherCustomer = { ...customerPayload, sub: "user-other" };
      await expect(service.findOne("cust-1", otherCustomer)).rejects.toThrow(ForbiddenException);
    });

    it("should throw NotFoundException when customer does not exist", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.findOne("nonexistent", operatorPayload)).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ─── create ───────────────────────────────────────────────────────────────

  describe("create", () => {
    it("should throw BadRequestException when email or username is taken", async () => {
      prisma.user.findFirst.mockResolvedValue({ id: "existing" });

      await expect(
        service.create({
          email: "taken@test.com",
          username: "taken",
          businessName: "Test",
          contactName: "Test",
        } as any),
      ).rejects.toThrow(BadRequestException);
    });

    const baseDto = { username: "acme", businessName: "Acme", contactName: "Jane" } as any;

    it("mints an internal placeholder email and leaves Customer.email null when none given", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });

      const res: any = await service.create({ ...baseDto });

      // User.email (required + unique) gets a non-routable internal placeholder…
      expect(prisma.user.create.mock.calls[0][0].data.email).toMatch(/@placeholder\.local$/);
      // …while Customer.email is never set to it.
      expect(prisma.customer.create.mock.calls[0][0].data).not.toHaveProperty("email");
      // Uniqueness check skips the email clause (an undefined email would match all users).
      expect(prisma.user.findFirst.mock.calls[0][0].where.OR).toEqual([{ username: "acme" }]);
      // Response surfaces the real (absent) email, not the placeholder.
      expect(res.user.email).toBeNull();
    });

    it("uses the real email on both User and Customer when provided", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "a@b.com" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });

      const res: any = await service.create({ ...baseDto, email: "a@b.com" });

      expect(prisma.user.create.mock.calls[0][0].data.email).toBe("a@b.com");
      expect(prisma.customer.create.mock.calls[0][0].data.email).toBe("a@b.com");
      expect(prisma.user.findFirst.mock.calls[0][0].where.OR).toEqual([
        { email: "a@b.com" },
        { username: "acme" },
      ]);
      expect(res.user.email).toBe("a@b.com");
    });

    // ─── create: geocode on customer create ──────────────────────────────────

    it("stores lat/lng on the created address when the geocoder succeeds", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : null,
      );
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          results: [{ geometry: { location: { lat: 40.7128, lng: -74.006 } } }],
        }),
      }) as any;

      await service.create({
        ...baseDto,
        addresses: [
          { label: "Main", line1: "123 Main St", city: "Springfield", state: "IL", zip: "62701" },
        ],
      });

      expect(prisma.customerAddress.createMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: [expect.objectContaining({ lat: 40.7128, lng: -74.006 })],
        }),
      );
    });

    it("still creates the customer with null lat/lng when the geocoder fails", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });
      configGet.mockImplementation((key: string) =>
        key === "googleMaps.apiKey" ? "test-key" : null,
      );
      global.fetch = jest.fn().mockRejectedValue(new Error("network down")) as any;

      const res: any = await service.create({
        ...baseDto,
        addresses: [
          { label: "Main", line1: "123 Main St", city: "Springfield", state: "IL", zip: "62701" },
        ],
      });

      // The write still succeeds…
      expect(res.customer).toEqual({ id: "c1" });
      // …and the address row carries no lat/lng at all (left null by the DB default).
      const createdData = prisma.customerAddress.createMany.mock.calls[0][0].data[0];
      expect(createdData).not.toHaveProperty("lat");
      expect(createdData).not.toHaveProperty("lng");
    });

    // ─── create: defaultDepositPercent (WP1) ────────────────────────────────

    it("stores defaultDepositPercent on the created customer when provided", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });

      await service.create({ ...baseDto, defaultDepositPercent: 50 });

      expect(prisma.customer.create.mock.calls[0][0].data).toHaveProperty(
        "defaultDepositPercent",
        50,
      );
    });

    it("omits defaultDepositPercent from the create data when not provided", async () => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u1", username: "acme", email: "placeholder" });
      prisma.customer.create.mockResolvedValue({ id: "c1" });

      await service.create({ ...baseDto });

      expect(prisma.customer.create.mock.calls[0][0].data).not.toHaveProperty(
        "defaultDepositPercent",
      );
    });
  });

  // ─── create: CUSTOMERS soft cap (WP3) ──────────────────────────────────────

  describe("create — CUSTOMERS soft cap", () => {
    const softCapDto = { username: "acme2", businessName: "Acme 2", contactName: "Jo" } as any;

    beforeEach(() => {
      prisma.user.findFirst.mockResolvedValue(null);
      prisma.user.create.mockResolvedValue({ id: "u2", username: "acme2", email: "e" });
      prisma.customer.create.mockResolvedValue({ id: "c2" });
    });

    it("a create that pushes the tenant over cap still succeeds and opens a grace window (upserting the subscription row a tenant may not have)", async () => {
      // Pre-check (before this create): exactly at cap — not yet over, so it is
      // allowed through (this create is the one that tips it over).
      meter.read
        .mockResolvedValueOnce({
          meter: "CUSTOMERS",
          used: 100,
          included: 100,
          remaining: 0,
          resetsAt: null,
        })
        // Post-check (after this create): now over cap.
        .mockResolvedValueOnce({
          meter: "CUSTOMERS",
          used: 101,
          included: 100,
          remaining: 0,
          resetsAt: null,
        });
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue(null); // no grace open yet
      prisma.tenant.findUnique.mockResolvedValue({ plan: "BUSINESS" });

      const res: any = await service.create({ ...softCapDto });

      expect(res.customer).toEqual({ id: "c2" });
      // upsert, not update: `update` throws P2025 for the many tenants with no
      // TenantSubscription row, so the window would never be recorded for them.
      // `currentPlan` is stamped from the tenant: its column default is STARTER, and
      // platform-admin reads `currentPlan` out of this table, so a defaulted row would
      // report this BUSINESS tenant as Starter from the moment it went over cap.
      expect((prisma as any).tenantSubscription.upsert).toHaveBeenCalledWith({
        where: { tenantId: "test-tenant" },
        create: {
          tenantId: "test-tenant",
          currentPlan: "BUSINESS",
          graceStartedAt: expect.any(Date),
          graceMeter: "CUSTOMERS",
        },
        update: { graceStartedAt: expect.any(Date), graceMeter: "CUSTOMERS" },
      });
    });

    it("does not re-open a grace window that is already open", async () => {
      meter.read.mockResolvedValue({
        meter: "CUSTOMERS",
        used: 101,
        included: 100,
        remaining: 0,
        resetsAt: null,
      });
      // A grace window opened yesterday — well within the 7-day window, so the
      // pre-check also lets this create through.
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        graceStartedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000),
      });

      const res: any = await service.create({ ...softCapDto });

      expect(res.customer).toEqual({ id: "c2" });
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("blocks a new create with the structured PLAN_GATE 403 once the grace window has expired while still over cap", async () => {
      meter.read.mockResolvedValue({
        meter: "CUSTOMERS",
        used: 101,
        included: 100,
        remaining: 0,
        resetsAt: null,
      });
      // Grace window opened 8 days ago — past the 7-day grace period.
      (prisma as any).tenantSubscription.findUnique.mockResolvedValue({
        graceStartedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000),
      });
      catalog.getPublishedVersion.mockResolvedValue({
        addonSkus: [{ sku: "CUSTOMER_PACK_100", monthlyPrice: 50 }],
      });

      let caught: any;
      try {
        await service.create({ ...softCapDto });
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ForbiddenException);
      expect(caught.getResponse()).toMatchObject({
        code: "PLAN_GATE",
        state: "INLINE_RESOLVE",
        upgrade: expect.objectContaining({
          addonSku: "CUSTOMER_PACK_100",
          addonMonthlyPrice: "50",
        }),
      });
      // Blocked before the transaction ever ran — no user/customer row created.
      expect(prisma.customer.create).not.toHaveBeenCalled();
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("fails open (create succeeds) when the plan/cap lookup is unresolvable", async () => {
      meter.read.mockRejectedValue(new Error("catalog unseeded"));

      const res: any = await service.create({ ...softCapDto });

      expect(res.customer).toEqual({ id: "c2" });
      expect((prisma as any).tenantSubscription.upsert).not.toHaveBeenCalled();
    });

    it("fails open when the grace-window lookup itself throws", async () => {
      meter.read.mockResolvedValueOnce({
        meter: "CUSTOMERS",
        used: 101,
        included: 100,
        remaining: 0,
        resetsAt: null,
      });
      (prisma as any).tenantSubscription.findUnique.mockRejectedValueOnce(new Error("db down"));

      const res: any = await service.create({ ...softCapDto });
      expect(res.customer).toEqual({ id: "c2" });
    });
  });

  // ─── update ───────────────────────────────────────────────────────────────

  describe("update", () => {
    it("should update customer fields", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.customer.update.mockResolvedValue({ ...MOCK_CUSTOMER, businessName: "New Name" });

      const result = await service.update("cust-1", { businessName: "New Name" } as any);

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "cust-1" },
        }),
      );
    });

    it("should throw NotFoundException for non-existent customer", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.update("nonexistent", {} as any)).rejects.toThrow(NotFoundException);
    });

    // ─── update: defaultDepositPercent (WP1) ────────────────────────────────

    it("forwards a numeric defaultDepositPercent to the update data", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.customer.update.mockResolvedValue({ ...MOCK_CUSTOMER, defaultDepositPercent: 50 });

      await service.update("cust-1", { defaultDepositPercent: 50 } as any);

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ defaultDepositPercent: 50 }) }),
      );
    });

    it("forwards null to clear a previously-set defaultDepositPercent", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.customer.update.mockResolvedValue({ ...MOCK_CUSTOMER, defaultDepositPercent: null });

      await service.update("cust-1", { defaultDepositPercent: null } as any);

      expect(prisma.customer.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ defaultDepositPercent: null }),
        }),
      );
    });

    it("omits defaultDepositPercent from the update data when not provided (no accidental clear)", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.customer.update.mockResolvedValue(MOCK_CUSTOMER);

      await service.update("cust-1", { businessName: "New Name" } as any);

      expect(prisma.customer.update.mock.calls[0][0].data).not.toHaveProperty(
        "defaultDepositPercent",
      );
    });
  });

  // ─── addAddress ───────────────────────────────────────────────────────────

  describe("addAddress", () => {
    it("should throw NotFoundException for non-existent customer", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);

      await expect(
        service.addAddress("nonexistent", {
          label: "Main",
          line1: "123 St",
          city: "NY",
          state: "NY",
          zip: "10001",
        } as any),
      ).rejects.toThrow(NotFoundException);
    });
  });

  // ─── updateAddress ────────────────────────────────────────────────────────

  describe("updateAddress", () => {
    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
    });

    it("passes addressType through to the update data (no field-picking omits it)", async () => {
      prisma.customerAddress.update.mockResolvedValue({
        id: "addr-1",
        customerId: "cust-1",
        addressType: "SHIPPING",
      });

      await service.updateAddress("cust-1", "addr-1", { addressType: "SHIPPING" } as any);

      expect(prisma.customerAddress.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "addr-1", customerId: "cust-1" },
          data: expect.objectContaining({ addressType: "SHIPPING" }),
        }),
      );
    });
  });

  // ─── deleteAddress (WP1) ──────────────────────────────────────────────────

  describe("deleteAddress", () => {
    const DEFAULT_ADDRESS = {
      id: "addr-1",
      customerId: "cust-1",
      isDefault: true,
      createdAt: new Date("2026-01-01"),
    };

    beforeEach(() => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
    });

    it("throws NotFoundException when the address does not exist", async () => {
      prisma.customerAddress.findFirst.mockResolvedValueOnce(null);

      await expect(service.deleteAddress("cust-1", "missing")).rejects.toThrow(NotFoundException);
      expect(prisma.customerAddress.delete).not.toHaveBeenCalled();
    });

    it("scopes the lookup to the given customerId, so an address on another customer 404s", async () => {
      // The where clause filters by customerId — a row belonging to a different
      // customer never matches, so the (mocked) DB lookup returns null just like
      // "unknown". Asserting the call args proves the scoping is actually wired,
      // not just that a null happens to throw.
      prisma.customerAddress.findFirst.mockResolvedValueOnce(null);

      await expect(service.deleteAddress("cust-1", "addr-of-other-customer")).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.customerAddress.findFirst).toHaveBeenCalledWith({
        where: { id: "addr-of-other-customer", customerId: "cust-1" },
      });
    });

    it("throws ConflictException (409) when a RouteStop references the address", async () => {
      prisma.customerAddress.findFirst.mockResolvedValueOnce(DEFAULT_ADDRESS);
      prisma.routeStop.count.mockResolvedValueOnce(1);
      prisma.routeRunStop.count.mockResolvedValueOnce(0);

      await expect(service.deleteAddress("cust-1", "addr-1")).rejects.toThrow(ConflictException);
      expect(prisma.customerAddress.delete).not.toHaveBeenCalled();
    });

    it("throws ConflictException (409) when a RouteRunStop references the address", async () => {
      prisma.customerAddress.findFirst.mockResolvedValueOnce(DEFAULT_ADDRESS);
      prisma.routeStop.count.mockResolvedValueOnce(0);
      prisma.routeRunStop.count.mockResolvedValueOnce(1);

      await expect(service.deleteAddress("cust-1", "addr-1")).rejects.toThrow(ConflictException);
      expect(prisma.customerAddress.delete).not.toHaveBeenCalled();
    });

    it("deletes a non-default, unreferenced address with no default-promotion", async () => {
      const nonDefault = { ...DEFAULT_ADDRESS, isDefault: false };
      prisma.customerAddress.findFirst.mockResolvedValueOnce(nonDefault);
      prisma.routeStop.count.mockResolvedValueOnce(0);
      prisma.routeRunStop.count.mockResolvedValueOnce(0);

      const result = await service.deleteAddress("cust-1", "addr-1");

      expect(prisma.customerAddress.delete).toHaveBeenCalledWith({
        where: { id: "addr-1", customerId: "cust-1" },
      });
      expect(prisma.customerAddress.update).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true });
    });

    it("promotes the oldest remaining address to isDefault when the deleted row was primary", async () => {
      prisma.customerAddress.findFirst
        .mockResolvedValueOnce(DEFAULT_ADDRESS) // pre-check lookup
        .mockResolvedValueOnce({ id: "addr-2", createdAt: new Date("2025-06-01") }); // oldest remaining, inside tx
      prisma.routeStop.count.mockResolvedValueOnce(0);
      prisma.routeRunStop.count.mockResolvedValueOnce(0);

      const result = await service.deleteAddress("cust-1", "addr-1");

      expect(prisma.customerAddress.delete).toHaveBeenCalledWith({
        where: { id: "addr-1", customerId: "cust-1" },
      });
      expect(prisma.customerAddress.update).toHaveBeenCalledWith({
        where: { id: "addr-2" },
        data: { isDefault: true },
      });
      expect(result).toEqual({ success: true });
    });

    it("deletes the last remaining default address with no promotion (none left to promote)", async () => {
      prisma.customerAddress.findFirst
        .mockResolvedValueOnce(DEFAULT_ADDRESS)
        .mockResolvedValueOnce(null); // no other address remains
      prisma.routeStop.count.mockResolvedValueOnce(0);
      prisma.routeRunStop.count.mockResolvedValueOnce(0);

      await service.deleteAddress("cust-1", "addr-1");

      expect(prisma.customerAddress.update).not.toHaveBeenCalled();
    });
  });

  // ─── DTO acceptance: defaultDepositPercent (WP1) ─────────────────────────

  describe("defaultDepositPercent DTO validation", () => {
    const baseCreatePayload = { username: "acme", businessName: "Acme", contactName: "Jane" };

    it("CreateCustomerDto accepts a numeric deposit percent within 0-100", async () => {
      const dto = plainToInstance(CreateCustomerDto, {
        ...baseCreatePayload,
        defaultDepositPercent: 50,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.defaultDepositPercent).toBe(50);
    });

    it("CreateCustomerDto rejects a deposit percent above 100", async () => {
      const dto = plainToInstance(CreateCustomerDto, {
        ...baseCreatePayload,
        defaultDepositPercent: 150,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === "defaultDepositPercent")).toBe(true);
    });

    it("CreateCustomerDto rejects a negative deposit percent", async () => {
      const dto = plainToInstance(CreateCustomerDto, {
        ...baseCreatePayload,
        defaultDepositPercent: -5,
      });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === "defaultDepositPercent")).toBe(true);
    });

    it("CreateCustomerDto leaves defaultDepositPercent undefined when omitted", async () => {
      const dto = plainToInstance(CreateCustomerDto, { ...baseCreatePayload });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.defaultDepositPercent).toBeUndefined();
    });

    it("UpdateCustomerDto accepts null to clear the deposit default", async () => {
      const dto = plainToInstance(UpdateCustomerDto, { defaultDepositPercent: null });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.defaultDepositPercent).toBeNull();
    });

    it("UpdateCustomerDto accepts a numeric deposit percent", async () => {
      const dto = plainToInstance(UpdateCustomerDto, { defaultDepositPercent: 25 });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.defaultDepositPercent).toBe(25);
    });

    it("UpdateCustomerDto rejects an out-of-range deposit percent (null bypass doesn't leak to numbers)", async () => {
      const dto = plainToInstance(UpdateCustomerDto, { defaultDepositPercent: 101 });
      const errors = await validate(dto);
      expect(errors.some((e) => e.property === "defaultDepositPercent")).toBe(true);
    });

    it("UpdateCustomerDto leaves defaultDepositPercent undefined when omitted (no accidental clear)", async () => {
      const dto = plainToInstance(UpdateCustomerDto, { businessName: "Acme Wholesale" });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
      expect(dto.defaultDepositPercent).toBeUndefined();
    });
  });

  // ─── findOrders ───────────────────────────────────────────────────────────

  describe("findOrders", () => {
    it("should throw ForbiddenException when non-owner customer tries to view", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      const otherCustomer = { ...customerPayload, sub: "user-other" };
      await expect(service.findOrders("cust-1", otherCustomer)).rejects.toThrow(ForbiddenException);
    });

    it("should return orders for operators", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.order.findMany.mockResolvedValue([]);
      prisma.order.count.mockResolvedValue(0);

      const result = await service.findOrders("cust-1", operatorPayload);
      expect(result.data).toEqual([]);
    });
  });

  // ─── restoreCustomer (Undo of a soft-delete) ────────────────────────────────

  describe("restoreCustomer", () => {
    it("clears deletedAt and reactivates the user for a soft-deleted customer", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: new Date(),
      });

      const result = await service.restoreCustomer("cust-1");

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: "cust-1" },
        data: { deletedAt: null },
      });
      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { status: "ACTIVE" },
      });
      expect(result).toEqual({ success: true, restored: true });
    });

    it("restores the user to the pre-delete status when given (SUSPENDED, not ACTIVE)", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: new Date(),
      });

      await service.restoreCustomer("cust-1", "SUSPENDED");

      expect(prisma.user.update).toHaveBeenCalledWith({
        where: { id: "user-1" },
        data: { status: "SUSPENDED" },
      });
    });

    it("is a no-op for a customer that is not soft-deleted", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        id: "cust-1",
        userId: "user-1",
        deletedAt: null,
      });

      const result = await service.restoreCustomer("cust-1");

      expect(prisma.customer.update).not.toHaveBeenCalled();
      expect(result).toEqual({ success: true, restored: false });
    });

    it("throws NotFoundException when the customer does not exist", async () => {
      prisma.customer.findUnique.mockResolvedValue(null);
      await expect(service.restoreCustomer("missing")).rejects.toThrow(NotFoundException);
    });
  });

  // ─── mergeCustomers: regulated authorization re-pointing ────────────────────
  describe("mergeCustomers (regulated authorizations)", () => {
    const PRIMARY = { id: "cust-primary", userId: "user-p" };
    const SECONDARY = { id: "cust-secondary", userId: "user-s" };

    const setup = (primaryAuths: any[], secondaryAuths: any[]) => {
      prisma.customer.findUnique.mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.id === PRIMARY.id ? PRIMARY : where.id === SECONDARY.id ? SECONDARY : null,
        ),
      );
      prisma.customerAuthorization.findMany.mockImplementation(({ where }: any) =>
        Promise.resolve(where.customerId === PRIMARY.id ? primaryAuths : secondaryAuths),
      );
    };

    it("moves a secondary license to the primary when the primary has none for that category", async () => {
      setup(
        [],
        [{ id: "auth-s", trackedCategoryId: "cat-tobacco", status: "VERIFIED", expiresAt: null }],
      );

      await service.mergeCustomers(PRIMARY.id, SECONDARY.id);

      expect(prisma.customerAuthorization.update).toHaveBeenCalledWith({
        where: { id: "auth-s" },
        data: { customerId: PRIMARY.id },
      });
      // Nothing deleted — the primary had no colliding row.
      expect(prisma.customerAuthorization.delete).not.toHaveBeenCalled();
    });

    it("keeps the stronger authorization on a category collision (secondary VERIFIED beats primary EXPIRED)", async () => {
      setup(
        [{ id: "auth-p", trackedCategoryId: "cat-tobacco", status: "EXPIRED", expiresAt: null }],
        [{ id: "auth-s", trackedCategoryId: "cat-tobacco", status: "VERIFIED", expiresAt: null }],
      );

      await service.mergeCustomers(PRIMARY.id, SECONDARY.id);

      // Primary's weaker row dropped, secondary's re-pointed onto the primary.
      expect(prisma.customerAuthorization.delete).toHaveBeenCalledWith({ where: { id: "auth-p" } });
      expect(prisma.customerAuthorization.update).toHaveBeenCalledWith({
        where: { id: "auth-s" },
        data: { customerId: PRIMARY.id },
      });
    });

    it("keeps the primary's authorization when it is at least as strong (drops the secondary's, no move)", async () => {
      setup(
        [{ id: "auth-p", trackedCategoryId: "cat-tobacco", status: "VERIFIED", expiresAt: null }],
        [{ id: "auth-s", trackedCategoryId: "cat-tobacco", status: "NONE", expiresAt: null }],
      );

      await service.mergeCustomers(PRIMARY.id, SECONDARY.id);

      expect(prisma.customerAuthorization.delete).toHaveBeenCalledWith({ where: { id: "auth-s" } });
      expect(prisma.customerAuthorization.update).not.toHaveBeenCalled();
    });

    it("re-points authorization overrides to the primary", async () => {
      setup([], []);

      await service.mergeCustomers(PRIMARY.id, SECONDARY.id);

      expect(prisma.authorizationOverride.updateMany).toHaveBeenCalledWith({
        where: { customerId: SECONDARY.id },
        data: { customerId: PRIMARY.id },
      });
    });
  });

  // ─── P5-13 — statement wallet balance (no double-count) ────────────────────
  describe("P5-13 — statement wallet balance (no double-count)", () => {
    const FUTURE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
    const PAST = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // A mixed set of credit notes: 60 open (partially used, remaining 60), a
    // fully-exhausted ISSUED note (remaining 0 — must not count), an expired-but-
    // still-ISSUED note (must not count), a VOID note (must not count even though
    // its raw amount − amountUsed is positive), and a plain 10 open note.
    // Expected wallet total: 60 + 10 = 70 — proves amount − amountUsed (not face
    // amount) drives the sum, so a partial credit's already-applied portion (which
    // sits on the invoice as a CREDIT_NOTE payment) is never double-counted.
    const CREDIT_NOTES = [
      {
        id: "cn-open-60",
        creditNoteNumber: "CN-1",
        amount: 100,
        amountUsed: 40,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: null,
      },
      {
        id: "cn-exhausted",
        creditNoteNumber: "CN-2",
        amount: 50,
        amountUsed: 50,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: null,
      },
      {
        id: "cn-expired",
        creditNoteNumber: "CN-3",
        amount: 25,
        amountUsed: 0,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: PAST,
      },
      {
        id: "cn-void",
        creditNoteNumber: "CN-4",
        amount: 15,
        amountUsed: 0,
        status: "VOID",
        createdAt: new Date(),
        expiresAt: null,
      },
      {
        id: "cn-open-10",
        creditNoteNumber: "CN-5",
        amount: 10,
        amountUsed: 0,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: FUTURE,
      },
    ];

    it("getMyStatement: availableCredit sums only open, non-expired, non-VOID remainders", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.creditNote.findMany.mockResolvedValue(CREDIT_NOTES);

      const result = await service.getMyStatement(customerPayload);

      expect(result.availableCredit).toBe(70);

      const expiredTx = result.transactions.find((t: any) => t.id === "cn-expired");
      expect(expiredTx.runningBalance).toBe(0);

      const openTx = result.transactions.find((t: any) => t.id === "cn-open-60");
      expect(openTx.runningBalance).toBe(60);
    });

    it("getStatementForOperator: availableCredit sums only open, non-expired, non-VOID remainders", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.creditNote.findMany.mockResolvedValue(CREDIT_NOTES);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      expect(result.availableCredit).toBe(70);

      const voidTx = result.transactions.find((t: any) => t.id === "cn-void");
      expect(voidTx.runningBalance).toBe(0);
    });
  });

  // ─── P5-12 fallout — VOID payments must not count as paid (AR snapshots) ─────
  // A bounced check flips its InvoicePayment.status to VOID (PaymentStatus enum =
  // DRAFT | PAID | VOID). Every all-time AR snapshot that sums payment amounts must
  // exclude VOID rows, or it under-states what the customer still owes. Mirrors the
  // P5-15 StatementService.receivableAt VOID filter (buyer/statement.service.ts).
  describe("P5-12 — VOID payments excluded from AR snapshots", () => {
    const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

    it("getMyStatement: a VOID (bounced) payment does not reduce outstanding/overdue", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          total: 100,
          status: "OVERDUE",
          dueDate: daysAgo(5),
          createdAt: daysAgo(20),
          payments: [
            { amount: 100, status: "VOID" }, // bounced — must NOT count as paid
            { amount: 30, status: "PAID" }, // real partial payment
          ],
        },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      const result = await service.getMyStatement(customerPayload);

      // amountPaid = 30 (VOID excluded) → outstanding = 70, and it is overdue.
      expect(result.outstandingAmount).toBe(70);
      expect(result.overdueAmount).toBe(70);
      const tx = result.transactions.find((t: any) => t.id === "inv-1");
      expect(tx.runningBalance).toBe(-70);
    });

    it("getStatementForOperator: a VOID payment does not reduce outstanding/overdue", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-1",
          invoiceNumber: "INV-1",
          total: 200,
          status: "OVERDUE",
          dueDate: daysAgo(3),
          createdAt: daysAgo(30),
          payments: [
            { amount: 200, status: "VOID" },
            { amount: 50, status: "PAID" },
          ],
        },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([]);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      expect(result.outstandingAmount).toBe(150);
      expect(result.overdueAmount).toBe(150);
    });

    it("findAll: customer receivables exclude VOID payments", async () => {
      prisma.customer.findMany.mockResolvedValue([MOCK_CUSTOMER]);
      prisma.customer.count.mockResolvedValue(1);
      prisma.invoice.findMany.mockResolvedValue([
        {
          customerId: "cust-1",
          total: 100,
          payments: [
            { amount: 100, status: "VOID" },
            { amount: 40, status: "PAID" },
          ],
        },
      ]);
      prisma.advancePayment.findMany.mockResolvedValue([]);

      const result = await service.findAll({ page: 1, limit: 20 });

      // 100 − 40 (VOID ignored) = 60, not 0.
      expect((result.data[0] as any).receivables).toBe(60);
    });

    it("exportCustomers: CSV receivables column excludes VOID payments", async () => {
      prisma.customer.findMany.mockResolvedValue([
        {
          ...MOCK_CUSTOMER,
          customerType: "RETAIL",
          user: { status: "ACTIVE" },
          invoices: [
            {
              total: 100,
              payments: [
                { amount: 100, status: "VOID" },
                { amount: 25, status: "PAID" },
              ],
            },
          ],
          advancePayments: [],
        },
      ]);

      const csv = await service.exportCustomers({});
      const dataLine = csv.split("\n")[1];
      // Receivables 75.00, Credits 0.00 → row tail ",75.00,0.00" (VOID's 100 ignored).
      expect(dataLine).toContain(",75.00,0.00");
    });

    it("applyAdvancePaymentToInvoice: a VOID payment is not treated as paid, so the full balance is applied", async () => {
      prisma.advancePayment.findUnique.mockResolvedValue({ id: "ap-1", balance: 100 });
      prisma.invoice.findUnique.mockResolvedValue({
        id: "inv-1",
        total: 100,
        status: "OVERDUE",
        dueDate: daysAgo(1),
        payments: [{ amount: 100, status: "VOID" }], // bounced — real balance is still 100
      });

      await service.applyAdvancePaymentToInvoice("ap-1", { invoiceId: "inv-1" });

      // Without the fix, alreadyPaid=100 → balance 0 → "no outstanding balance" throw.
      // With the fix, alreadyPaid=0 → the full 100 is applied.
      expect(prisma.invoicePayment.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ amount: 100, method: "ADVANCE" }),
        }),
      );
      expect(prisma.advancePayment.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { balance: { decrement: 100 } } }),
      );
    });

    it("B310: two concurrent applies of the SAME advance never drive its balance negative", async () => {
      // The mocked `withAdvisoryLock` is a module-level jest.fn shared across every test in this
      // file (a prior test above also calls applyAdvancePaymentToInvoice) — clear its call
      // history so the per-call key assertion below only sees calls THIS test made.
      (mockedWithAdvisoryLock as jest.Mock).mockClear();
      let balance = 100;
      const customerId = "cust-wallet-1";
      prisma.advancePayment.findUnique.mockImplementation(async () => ({
        id: "ap-1",
        balance,
        customerId,
      }));
      prisma.advancePayment.update.mockImplementation(async ({ data }: any) => {
        balance = balance - Number(data.balance.decrement);
        return { id: "ap-1", balance };
      });
      prisma.invoice.findUnique.mockImplementation(async ({ where }: any) => ({
        id: where.id,
        total: 100,
        status: "SENT",
        dueDate: null,
        payments: [],
      }));

      // Two DIFFERENT $100 invoices, both trying to spend the SAME $100 advance at once.
      // Without a lock between the read and the decrement, both see balance=100, both
      // qualify, and both apply — driving the wallet to -100 (money spent twice). With the
      // fix, the second apply's critical section only starts after the first's decrement has
      // landed, sees balance=0, and correctly REJECTS ("no remaining balance") instead of
      // silently overdrawing the wallet.
      const results = await Promise.allSettled([
        service.applyAdvancePaymentToInvoice("ap-1", { invoiceId: "inv-a" }),
        service.applyAdvancePaymentToInvoice("ap-1", { invoiceId: "inv-b" }),
      ]);

      expect(balance).toBeGreaterThanOrEqual(0);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(prisma.invoicePayment.create).toHaveBeenCalledTimes(1);

      // Direct guard against a wrong-key regression (e.g. locking on invoiceId instead of
      // customerId, which would silently stop serializing the SAME advance applied to two
      // DIFFERENT invoices — the exact scenario above — while still reading as "locked").
      // The balance/fulfilled-count assertions above can pass by timing luck even with the
      // wrong key (both mocked lock chains still resolve, just independently); this pins the
      // actual key so that coincidence can't mask a regression.
      expect(mockedWithAdvisoryLock).toHaveBeenCalledWith(
        expect.objectContaining({ family: "order-merge", key: customerId }),
        expect.any(Function),
      );
      for (const [opts] of (mockedWithAdvisoryLock as jest.Mock).mock.calls) {
        expect(opts.key).toBe(customerId);
      }
    });

    // F03 (R1): the monthly-income query must use the same CONFIRMED predicate as
    // getCashFlow / the bookkeeping dashboards — a DRAFT (unconfirmed) payment showed
    // as collected income here while every other money read reported 0.
    it("getIncomeChart: the monthly-income query counts only CONFIRMED payments", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.expense.findMany.mockResolvedValue([]);

      await service.getIncomeChart("cust-1");

      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: "PAID" }),
        }),
      );
    });
  });

  // ─── T2 (REG-B169) — orderBy carries an id tiebreaker (createdAt ties are
  // structural — a bulk import can share one createdAt across many rows).
  describe("REG-B169 — orderBy carries an id tiebreaker", () => {
    it("findAll: default sort orders by createdAt desc, id desc", async () => {
      prisma.customer.findMany.mockResolvedValue([]);
      prisma.customer.count.mockResolvedValue(0);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.advancePayment.findMany.mockResolvedValue([]);

      await service.findAll({ page: 1, limit: 20 });

      expect(prisma.customer.findMany.mock.calls[0][0].orderBy).toEqual([
        { createdAt: "desc" },
        { id: "desc" },
      ]);
    });

    // m9 — the sort allowlist is a plain object literal, so a bare index
    // lookup resolves INHERITED keys: `sortBy=constructor` returns Object's
    // constructor and `sortBy=__proto__` returns Object.prototype, either of
    // which reaches Prisma as a malformed orderBy (→ 500). Both must fall back
    // to the same order the default does.
    it.each(["constructor", "__proto__", "toString", "valueOf"])(
      "findAll: sortBy=%s is not an allowlisted field — falls back to the default order",
      async (sortBy) => {
        prisma.customer.findMany.mockResolvedValue([]);
        prisma.customer.count.mockResolvedValue(0);
        prisma.invoice.findMany.mockResolvedValue([]);
        prisma.advancePayment.findMany.mockResolvedValue([]);

        await service.findAll({ page: 1, limit: 20, sortBy } as any);

        expect(prisma.customer.findMany.mock.calls[0][0].orderBy).toEqual([
          { createdAt: "desc" },
          { id: "desc" },
        ]);
      },
    );
  });

  /** A findMany mock that HONOURS `take`/`skip` AND the `where` status/balance
   * filters against a fixed row set. A mock that ignores `take` would make the
   * REG-B110 tests vacuous; one that ignores `where` could not tell the OPEN-set
   * reads (status-filtered, uncapped) apart from the LEDGER reads (all statuses,
   * capped), which is exactly what those tests exist to distinguish. */
  const honouringTake = (rows: any[]) =>
    jest.fn((args: any = {}) => {
      const where = args?.where ?? {};
      let matched = rows;
      if (where.status?.notIn) {
        matched = matched.filter((r: any) => !where.status.notIn.includes(r.status));
      }
      if (where.status?.not !== undefined) {
        matched = matched.filter((r: any) => r.status !== where.status.not);
      }
      if (where.balance?.gt !== undefined) {
        matched = matched.filter((r: any) => Number(r.balance) > where.balance.gt);
      }
      const skip = args?.skip ?? 0;
      const take = args?.take ?? matched.length;
      return Promise.resolve(matched.slice(skip, skip + take));
    });

  // ─── T4 (REG-B110) — getStatementForOperator's four money figures come from
  // UNCAPPED reads over the whole/open set; the take:100/50/50 caps stay for
  // the transactions LEDGER display only, and a capped ledger surfaces
  // transactionsTruncated so the UI can label it a partial view.
  describe("REG-B110 — getStatementForOperator reads the WHOLE set for money, not the capped page", () => {
    it("150 open invoices / 60 credit notes / 60 advances: money figures cover the WHOLE set, and the ledger reports truncated", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      const invoices = Array.from({ length: 150 }, (_, i) => ({
        id: `inv-${i}`,
        invoiceNumber: `INV-${i}`,
        total: 10,
        status: "SENT",
        dueDate: null,
        createdAt: new Date(),
        payments: [],
      }));
      const creditNotes = Array.from({ length: 60 }, (_, i) => ({
        id: `cn-${i}`,
        creditNoteNumber: `CN-${i}`,
        amount: 5,
        amountUsed: 0,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: null,
      }));
      const advancePayments = Array.from({ length: 60 }, (_, i) => ({
        id: `ap-${i}`,
        amount: 2,
        balance: 2,
        method: "CASH",
        reference: null,
        receivedAt: new Date(),
      }));

      prisma.invoice.findMany.mockImplementation(honouringTake(invoices));
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNotes));
      prisma.advancePayment.findMany.mockImplementation(honouringTake(advancePayments));
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      // ONE matcher over all four figures, so a red tree exercises every oracle
      // instead of stopping at the first failed `expect` (outstandingAmount).
      //   outstandingAmount: 150 × $10, no payments — the whole set, not just
      //     the first 100 (take:100).            TODAY 1000
      //   availableCredit:   60 × $5 remaining — not just the first 50 (take:50).
      //                                          TODAY 250
      //   advanceBalance:    60 × $2 remaining — not just the first 50 (take:50).
      //                                          TODAY 100
      //   transactionsTruncated: every read above is capped below its own count,
      //     so the ledger the UI renders is a partial view.  TODAY undefined
      expect({
        outstandingAmount: result.outstandingAmount,
        availableCredit: result.availableCredit,
        advanceBalance: result.advanceBalance,
        transactionsTruncated: (result as any).transactionsTruncated,
      }).toEqual({
        outstandingAmount: 1500,
        availableCredit: 300,
        advanceBalance: 120,
        transactionsTruncated: true,
      });
    });

    // M1 — the statement header's "Invoiced Amount" / "Amount Received" tiles
    // are LIFETIME figures and sit beside the (uncapped) Outstanding/Overdue
    // ones, so they must come from a DB aggregate over the whole history, not
    // a reduce over the take-capped `transactions` ledger. The oracle is the
    // aggregate's own `_sum`: values that NO reduce over the 150-row fixture
    // could produce, so a capped (or uncapped) client-side reduce fails here.
    it("lifetimeInvoiced/lifetimeReceived come from the DB aggregates, not a reduce over the capped ledger (M1)", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      // 150 invoices, each with a CONFIRMED $4 payment: a reduce over the
      // ledger's first 100 rows gives 1000/400 and an uncapped reduce over the
      // OPEN set gives 1500/600 — neither is what the aggregates report,
      // because the lifetime figures also include the PAID/WRITTEN_OFF history
      // the OPEN-set read deliberately drops.
      const invoices = Array.from({ length: 150 }, (_, i) => ({
        id: `inv-${i}`,
        invoiceNumber: `INV-${i}`,
        total: 10,
        status: "SENT",
        dueDate: null,
        createdAt: new Date(),
        payments: [{ amount: 4, status: "PAID" }],
      }));
      prisma.invoice.findMany.mockImplementation(honouringTake(invoices));
      prisma.creditNote.findMany.mockResolvedValue([]);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 1750 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 643.219 } });

      const result: any = await service.getStatementForOperator("cust-1");

      expect({
        lifetimeInvoiced: result.lifetimeInvoiced,
        lifetimeReceived: result.lifetimeReceived,
      }).toEqual({
        lifetimeInvoiced: 1750,
        // roundMoney on every monetary result — cents, never a raw float.
        lifetimeReceived: 643.22,
      });

      // Billed history, not the OPEN set: DRAFT (never issued) and VOID
      // (cancelled) are the only exclusions — PAID/OVERDUE/WRITTEN_OFF are
      // real past billings and belong in a lifetime total.
      const invoiceAggArgs = prisma.invoice.aggregate.mock.calls[0][0];
      expect(invoiceAggArgs._sum).toEqual({ total: true });
      expect(invoiceAggArgs.where.customerId).toBe("cust-1");
      expect(new Set(invoiceAggArgs.where.status.notIn)).toEqual(new Set(["DRAFT", "VOID"]));
      expect(invoiceAggArgs.take).toBeUndefined();

      // Received money is the CONFIRMED (PAID) basis — a DRAFT (unconfirmed)
      // or VOID (bounced) payment is not money received — scoped to this
      // customer's invoices.
      const paymentAggArgs = prisma.invoicePayment.aggregate.mock.calls[0][0];
      expect(paymentAggArgs._sum).toEqual({ amount: true });
      expect(paymentAggArgs.where.status).toBe("PAID");
      expect(paymentAggArgs.where.invoice).toEqual({ customerId: "cust-1" });
      expect(paymentAggArgs.take).toBeUndefined();
    });

    it("a small history (5 open invoices / 2 credit notes / 1 advance, all under the caps) reports transactionsTruncated false", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      const invoices = Array.from({ length: 5 }, (_, i) => ({
        id: `inv-${i}`,
        invoiceNumber: `INV-${i}`,
        total: 10,
        status: "SENT",
        dueDate: null,
        createdAt: new Date(),
        payments: [],
      }));
      const creditNotes = Array.from({ length: 2 }, (_, i) => ({
        id: `cn-${i}`,
        creditNoteNumber: `CN-${i}`,
        amount: 5,
        amountUsed: 0,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: null,
      }));
      const advancePayments = [
        {
          id: "ap-0",
          amount: 2,
          balance: 2,
          method: "CASH",
          reference: null,
          receivedAt: new Date(),
        },
      ];

      prisma.invoice.findMany.mockImplementation(honouringTake(invoices));
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNotes));
      prisma.advancePayment.findMany.mockImplementation(honouringTake(advancePayments));
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      // The negative side of the flag: nothing is capped away here, so the
      // ledger IS the whole history and transactionsTruncated must be false —
      // a hardcoded `true` fails this case — while the money figures still
      // sum the open set.
      expect({
        outstandingAmount: result.outstandingAmount,
        availableCredit: result.availableCredit,
        advanceBalance: result.advanceBalance,
        transactionsTruncated: (result as any).transactionsTruncated,
      }).toEqual({
        outstandingAmount: 50,
        availableCredit: 10,
        advanceBalance: 2,
        transactionsTruncated: false,
      });
    });

    it("a $100 invoice with DRAFT $40 + VOID $30 + PAID $20 payments: outstandingAmount is $80, the CONFIRMED (PAID) basis", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-mixed",
          invoiceNumber: "INV-MIXED",
          total: 100,
          status: "SENT",
          dueDate: null,
          createdAt: new Date(),
          payments: [
            { amount: 40, status: "DRAFT" },
            { amount: 30, status: "VOID" },
            { amount: 20, status: "PAID" },
          ],
        },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([]);
      prisma.advancePayment.findMany.mockResolvedValue([]);
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      // CONFIRMED (PAID) basis: only the $20 PAID row counts as paid, so
      // outstanding = 100 − 20 = 80 — NOT 100 − (40 + 20) = 40, which is what
      // today's `status !== "VOID"` basis gives by wrongly counting the
      // unconfirmed DRAFT $40 as paid.
      expect(result.outstandingAmount).toBe(80);
    });

    // The case that DISTINGUISHES the two possible bases for the flag: the OPEN
    // set (20) sits far below the ledger cap while the ledger's own population
    // (320 rows, all statuses) sits far above it. A flag derived from the
    // open-set size answers `false` here — on a ledger showing 100 of 320.
    it("20 open + 300 settled invoices: the ledger reports truncated even though the open set fits the cap", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);

      const openRows = Array.from({ length: 20 }, (_, i) => ({
        id: `inv-open-${i}`,
        invoiceNumber: `INV-OPEN-${i}`,
        total: 10,
        status: "SENT",
        dueDate: null,
        createdAt: new Date(),
        payments: [],
      }));
      const settledRows = Array.from({ length: 300 }, (_, i) => ({
        id: `inv-paid-${i}`,
        invoiceNumber: `INV-PAID-${i}`,
        total: 999,
        status: "PAID",
        dueDate: null,
        createdAt: new Date(),
        payments: [{ amount: 999, status: "PAID" }],
      }));

      prisma.invoice.findMany.mockImplementation(honouringTake([...openRows, ...settledRows]));
      prisma.creditNote.findMany.mockImplementation(
        honouringTake([
          {
            id: "cn-1",
            creditNoteNumber: "CN-1",
            amount: 5,
            amountUsed: 0,
            status: "ISSUED",
            createdAt: new Date(),
            expiresAt: null,
          },
        ]),
      );
      prisma.advancePayment.findMany.mockImplementation(
        honouringTake([
          {
            id: "ap-1",
            amount: 2,
            balance: 2,
            method: "CASH",
            reference: null,
            receivedAt: new Date(),
          },
        ]),
      );
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      expect({
        outstandingAmount: result.outstandingAmount,
        transactionsTruncated: (result as any).transactionsTruncated,
        invoiceLedgerRows: result.transactions.filter((t: any) => t.type === "INVOICE").length,
      }).toEqual({
        outstandingAmount: 200,
        transactionsTruncated: true,
        // exactly the cap — the CAP + 1 probe row is never rendered
        invoiceLedgerRows: 100,
      });
    });

    // A DRAFT invoice is not yet issued, so it is not receivable — the same
    // exclusion the invoices KPI summary makes (KPI_SUMMARY_EXCLUDED) and the
    // one the Invoices-tab Outstanding card used to make client-side before it
    // was repointed at this figure.
    it("a DRAFT invoice never inflates outstanding/overdue", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          {
            id: "inv-sent",
            invoiceNumber: "INV-SENT",
            total: 500,
            status: "SENT",
            dueDate: past,
            createdAt: past,
            payments: [],
          },
          {
            id: "inv-draft",
            invoiceNumber: "INV-DRAFT",
            total: 5000,
            status: "DRAFT",
            dueDate: past,
            createdAt: past,
            payments: [],
          },
        ]),
      );
      prisma.creditNote.findMany.mockImplementation(honouringTake([]));
      prisma.advancePayment.findMany.mockImplementation(honouringTake([]));
      prisma.order.findMany.mockResolvedValue([]);

      const result = await service.getStatementForOperator("cust-1");

      expect({
        outstandingAmount: result.outstandingAmount,
        overdueAmount: result.overdueAmount,
      }).toEqual({ outstandingAmount: 500, overdueAmount: 500 });
    });
  });

  // ─── T4 (REG-B110) — the buyer-facing twin. build-plan P3 requires the same
  // uncapped OPEN-set money reads "in `getStatementForOperator` (and
  // `getMyStatement`)": here the take:50 caps are for the transactions LEDGER
  // display only, and reverting just this half must go red.
  describe("REG-B110 — getMyStatement reads the WHOLE set for money, not the capped page", () => {
    const invoiceRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `inv-${i}`,
        invoiceNumber: `INV-${i}`,
        total: 10,
        status: "SENT",
        dueDate: null,
        createdAt: new Date(),
        payments: [],
      }));
    const creditNoteRows = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: `cn-${i}`,
        creditNoteNumber: `CN-${i}`,
        amount: 5,
        amountUsed: 0,
        status: "ISSUED",
        createdAt: new Date(),
        expiresAt: null,
      }));

    it("150 open invoices / 60 credit notes: money figures cover the WHOLE set, and the ledger reports truncated", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(invoiceRows(150)));
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNoteRows(60)));

      const result = await service.getMyStatement(customerPayload);

      // ONE matcher over the figures so a red tree exercises every oracle.
      //   outstandingAmount: 150 × $10, no payments — the whole set, not just
      //     the first 50 (take:50).                TODAY 500
      //   availableCredit:   60 × $5 remaining — not just the first 50.
      //                                            TODAY 250
      //   transactionsTruncated: both reads are capped below their own count.
      expect({
        outstandingAmount: result.outstandingAmount,
        availableCredit: result.availableCredit,
        transactionsTruncated: (result as any).transactionsTruncated,
      }).toEqual({
        outstandingAmount: 1500,
        availableCredit: 300,
        transactionsTruncated: true,
      });
    });

    it("the transactions LEDGER stays capped at 50 invoice rows while the money reads are uncapped", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(invoiceRows(150)));
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNoteRows(60)));

      const result = await service.getMyStatement(customerPayload);

      // The fix lifts the cap off the MONEY reads only — the ledger the UI
      // renders keeps its take:50 display cap.
      expect(result.transactions.filter((t: any) => t.type === "INVOICE")).toHaveLength(50);
      expect(result.transactions.filter((t: any) => t.type === "CREDIT_NOTE")).toHaveLength(50);
    });

    it("a $100 invoice with DRAFT $40 + VOID $30 + PAID $20 payments: outstandingAmount is $80, the CONFIRMED (PAID) basis", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-mixed",
          invoiceNumber: "INV-MIXED",
          total: 100,
          status: "SENT",
          dueDate: null,
          createdAt: new Date(),
          payments: [
            { amount: 40, status: "DRAFT" },
            { amount: 30, status: "VOID" },
            { amount: 20, status: "PAID" },
          ],
        },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      const result = await service.getMyStatement(customerPayload);

      // CONFIRMED (PAID) basis: only the $20 PAID row counts as paid, so
      // outstanding = 100 − 20 = 80 — NOT 100 − (40 + 20) = 40, which is what
      // a `status !== "VOID"` basis gives by wrongly counting the unconfirmed
      // DRAFT $40 as paid.
      expect(result.outstandingAmount).toBe(80);
    });

    it("a $100 invoice whose ONLY payment is a DRAFT $40: outstandingAmount stays $100", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([
        {
          id: "inv-draft-only",
          invoiceNumber: "INV-DRAFT-ONLY",
          total: 100,
          status: "SENT",
          dueDate: null,
          createdAt: new Date(),
          payments: [{ amount: 40, status: "DRAFT" }],
        },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      const result = await service.getMyStatement(customerPayload);

      // An unconfirmed DRAFT payment is excluded outright, not merely netted
      // against a confirmed one: with no PAID row at all the whole $100 is
      // still outstanding.
      expect(result.outstandingAmount).toBe(100);
    });

    // M1 — the buyer-facing twin: same DB-aggregate basis for the two lifetime
    // figures, so reverting just this half goes red too.
    it("lifetimeInvoiced/lifetimeReceived come from the DB aggregates, not a reduce over the capped ledger (M1)", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(invoiceRows(150)));
      prisma.creditNote.findMany.mockResolvedValue([]);
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: 1725 } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: 88.005 } });

      const result: any = await service.getMyStatement(customerPayload);

      // 150 × $10 = 1500 (uncapped reduce) and 50 × $10 = 500 (the ledger's
      // capped reduce) are both WRONG — the aggregate's own sum is the oracle.
      expect({
        lifetimeInvoiced: result.lifetimeInvoiced,
        lifetimeReceived: result.lifetimeReceived,
      }).toEqual({ lifetimeInvoiced: 1725, lifetimeReceived: 88.01 });

      const invoiceAggArgs = prisma.invoice.aggregate.mock.calls[0][0];
      expect(invoiceAggArgs._sum).toEqual({ total: true });
      expect(invoiceAggArgs.where.customerId).toBe(MOCK_CUSTOMER.id);
      expect(new Set(invoiceAggArgs.where.status.notIn)).toEqual(new Set(["DRAFT", "VOID"]));
      expect(invoiceAggArgs.take).toBeUndefined();

      const paymentAggArgs = prisma.invoicePayment.aggregate.mock.calls[0][0];
      expect(paymentAggArgs._sum).toEqual({ amount: true });
      expect(paymentAggArgs.where.status).toBe("PAID");
      // Scoped to the CALLER's own customer row, resolved from the JWT.
      expect(paymentAggArgs.where.invoice).toEqual({ customerId: MOCK_CUSTOMER.id });
      expect(paymentAggArgs.take).toBeUndefined();
    });

    it("a lifetime with no billed history at all reports $0.00, never NaN (M1)", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockResolvedValue([]);
      prisma.creditNote.findMany.mockResolvedValue([]);
      // Postgres SUM() over an empty set is NULL — Prisma surfaces it as null.
      prisma.invoice.aggregate.mockResolvedValue({ _sum: { total: null } });
      prisma.invoicePayment.aggregate.mockResolvedValue({ _sum: { amount: null } });

      const result: any = await service.getMyStatement(customerPayload);

      expect({
        lifetimeInvoiced: result.lifetimeInvoiced,
        lifetimeReceived: result.lifetimeReceived,
      }).toEqual({ lifetimeInvoiced: 0, lifetimeReceived: 0 });
    });

    it("a small history (5 open invoices / 2 credit notes, under the caps) reports transactionsTruncated false", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(invoiceRows(5)));
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNoteRows(2)));

      const result = await service.getMyStatement(customerPayload);

      expect({
        outstandingAmount: result.outstandingAmount,
        availableCredit: result.availableCredit,
        transactionsTruncated: (result as any).transactionsTruncated,
      }).toEqual({
        outstandingAmount: 50,
        availableCredit: 10,
        transactionsTruncated: false,
      });
    });

    // The distinguishing case, buyer side: 20 open invoices (below the cap) but
    // 320 rows of history (well above it).
    it("20 open + 300 settled invoices: the ledger reports truncated even though the open set fits the cap", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);

      const settledRows = Array.from({ length: 300 }, (_, i) => ({
        id: `inv-paid-${i}`,
        invoiceNumber: `INV-PAID-${i}`,
        total: 999,
        status: "PAID",
        dueDate: null,
        createdAt: new Date(),
        payments: [{ amount: 999, status: "PAID" }],
      }));

      prisma.invoice.findMany.mockImplementation(
        honouringTake([...invoiceRows(20), ...settledRows]),
      );
      prisma.creditNote.findMany.mockImplementation(honouringTake(creditNoteRows(1)));

      const result = await service.getMyStatement(customerPayload);

      expect({
        outstandingAmount: result.outstandingAmount,
        transactionsTruncated: (result as any).transactionsTruncated,
        invoiceLedgerRows: result.transactions.filter((t: any) => t.type === "INVOICE").length,
      }).toEqual({
        outstandingAmount: 200,
        transactionsTruncated: true,
        // exactly the cap — the CAP + 1 probe row is never rendered
        invoiceLedgerRows: 50,
      });
    });

    it("a DRAFT invoice never inflates outstanding/overdue", async () => {
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      prisma.invoice.findMany.mockImplementation(
        honouringTake([
          {
            id: "inv-sent",
            invoiceNumber: "INV-SENT",
            total: 500,
            status: "SENT",
            dueDate: past,
            createdAt: past,
            payments: [],
          },
          {
            id: "inv-draft",
            invoiceNumber: "INV-DRAFT",
            total: 5000,
            status: "DRAFT",
            dueDate: past,
            createdAt: past,
            payments: [],
          },
        ]),
      );
      prisma.creditNote.findMany.mockImplementation(honouringTake([]));

      const result = await service.getMyStatement(customerPayload);

      expect({
        outstandingAmount: result.outstandingAmount,
        overdueAmount: result.overdueAmount,
      }).toEqual({ outstandingAmount: 500, overdueAmount: 500 });
    });
  });

  // ─── H2 — every money figure a statement returns is rounded to cents. The
  // figures are float reduces over invoice/advance/order rows, so an unrounded
  // sum leaks binary-float dust (the classic 0.1 + 0.2 = 0.30000000000000004)
  // straight into the operator's and the buyer's screens. One pin per method,
  // with a fixture whose raw reduce is provably dusty.
  describe("H2 — statement money figures are rounded to cents", () => {
    const dustyInvoices = (dueDate: Date | null) => [
      {
        id: "inv-dust-1",
        invoiceNumber: "INV-DUST-1",
        total: 0.1,
        status: "SENT",
        dueDate,
        createdAt: new Date(),
        payments: [],
      },
      {
        id: "inv-dust-2",
        invoiceNumber: "INV-DUST-2",
        total: 0.2,
        status: "SENT",
        dueDate,
        createdAt: new Date(),
        payments: [],
      },
    ];

    it("getStatementForOperator: outstanding/overdue/advanceBalance/pendingOrdersAmount are cents, not 0.30000000000000004", async () => {
      // Guard the fixture itself: the raw reduce these four figures perform IS
      // dusty, so an unrounded implementation cannot pass by accident.
      expect(0.1 + 0.2).not.toBe(0.3);

      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(dustyInvoices(past)));
      prisma.creditNote.findMany.mockImplementation(honouringTake([]));
      prisma.advancePayment.findMany.mockImplementation(
        honouringTake([
          {
            id: "ap-dust-1",
            amount: 0.1,
            balance: 0.1,
            method: "CASH",
            reference: null,
            receivedAt: new Date(),
          },
          {
            id: "ap-dust-2",
            amount: 0.2,
            balance: 0.2,
            method: "CASH",
            reference: null,
            receivedAt: new Date(),
          },
        ]),
      );
      prisma.order.findMany.mockResolvedValue([
        { id: "ord-dust-1", total: 0.1, orderNumber: "ORD-1", status: "PENDING", createdAt: past },
        {
          id: "ord-dust-2",
          total: 0.2,
          orderNumber: "ORD-2",
          status: "CONFIRMED",
          createdAt: past,
        },
      ]);

      const result = await service.getStatementForOperator("cust-1");

      // ONE matcher over all four figures so a red tree exercises every oracle.
      expect({
        outstandingAmount: result.outstandingAmount,
        overdueAmount: result.overdueAmount,
        advanceBalance: result.advanceBalance,
        pendingOrdersAmount: result.pendingOrdersAmount,
      }).toEqual({
        outstandingAmount: 0.3,
        overdueAmount: 0.3,
        advanceBalance: 0.3,
        pendingOrdersAmount: 0.3,
      });
    });

    it("getMyStatement: outstanding/overdue are cents, not 0.30000000000000004", async () => {
      expect(0.1 + 0.2).not.toBe(0.3);

      const past = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
      prisma.customer.findFirst.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoice.findMany.mockImplementation(honouringTake(dustyInvoices(past)));
      prisma.creditNote.findMany.mockImplementation(honouringTake([]));

      const result = await service.getMyStatement(customerPayload);

      expect({
        outstandingAmount: result.outstandingAmount,
        overdueAmount: result.overdueAmount,
      }).toEqual({ outstandingAmount: 0.3, overdueAmount: 0.3 });
    });
  });

  // ─── upsertCustomerPrice — MSRP-era partial-update + role-gated implicit delete ───

  describe("upsertCustomerPrice", () => {
    const driverPayload = { ...operatorPayload, role: "DRIVER" as const };

    it("400s when neither pricingTier nor msrp is present", async () => {
      await expect(
        service.upsertCustomerPrice("cust-1", { productId: "p1" }, operatorPayload),
      ).rejects.toThrow(BadRequestException);
    });

    it("a tier-only update preserves an existing MSRP override (partial update)", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 2, msrp: 5 });
      prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-1" });

      await service.upsertCustomerPrice(
        "cust-1",
        { productId: "p1", pricingTier: 4 },
        operatorPayload,
      );

      expect(prisma.customerPrice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ pricingTier: 4, msrp: 5 }),
        }),
      );
    });

    it("clearing the last remaining field deletes the row — for an OPERATOR", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: null });
      prisma.customerPrice.delete.mockResolvedValue({ id: "cp-1" });

      const result = await service.upsertCustomerPrice(
        "cust-1",
        { productId: "p1", pricingTier: null },
        operatorPayload,
      );

      expect(result).toBeNull();
      expect(prisma.customerPrice.delete).toHaveBeenCalledWith({ where: { id: "cp-1" } });
    });

    it("a DRIVER cannot use {pricingTier: null} as a delete primitive (DELETE route is OPERATOR-only)", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: null });

      await expect(
        service.upsertCustomerPrice(
          "cust-1",
          { productId: "p1", pricingTier: null },
          driverPayload,
        ),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.customerPrice.delete).not.toHaveBeenCalled();
    });

    // T8 (REG-B132): this test used to be titled "a DRIVER may still null the
    // tier on a row that keeps its MSRP (no delete involved)" and asserted the
    // BUG — that a DRIVER's write reached upsert() as long as an implicit
    // delete wasn't triggered. The gate must be hoisted above every read, not
    // conditioned on which fields happen to clear the row.
    it("REG-B132 a DRIVER cannot null the tier even on a row that keeps its MSRP — refused before any read", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });

      const err = await service
        .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: null }, driverPayload)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(String(err.message)).toMatch(/^Only operators/);
      expect(prisma.customerPrice.findUnique).not.toHaveBeenCalled();
      expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
      expect(prisma.customerPrice.delete).not.toHaveBeenCalled();
    });

    it("REG-B132 a DRIVER posting a tier is refused before the MSRP entitlement or any DB read", async () => {
      // flag.msrp ON so that, pre-fix, assertMsrpAllowed returns quietly and the
      // DRIVER's write runs all the way through to upsert(). With the flag OFF
      // the plan-gate branch reaches catalog.upgradeTargetForFlag — absent from
      // the stub — and the test would fail on a TypeError, unable to tell "the
      // driver wrote" from "the code crashed". Post-fix the hoisted role gate
      // short-circuits above this call and msrpSpy is never reached.
      entitlements.hasFlag.mockResolvedValue(true);
      const msrpSpy = jest.spyOn(service as any, "assertMsrpAllowed");
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });

      const err = await service
        .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: 4, msrp: 7 }, driverPayload)
        .catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(String(err.message)).toMatch(/^Only operators/);
      expect(msrpSpy).not.toHaveBeenCalled();
      expect(prisma.customerPrice.findUnique).not.toHaveBeenCalled();
      expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
    });

    it("REG-B132 an undefined user is refused (no caller identity → no override change)", async () => {
      const err = await service
        .upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: 4 }, undefined as any)
        .catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(prisma.customerPrice.upsert).not.toHaveBeenCalled();
    });

    it("pin (B132): OPERATOR and TENANT_ADMIN still upsert (partial update preserved)", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });
      prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-1" });
      await service.upsertCustomerPrice(
        "cust-1",
        { productId: "p1", pricingTier: 4 },
        operatorPayload,
      );
      await service.upsertCustomerPrice(
        "cust-1",
        { productId: "p1", pricingTier: 4 },
        { ...operatorPayload, role: "TENANT_ADMIN" as const },
      );
      expect(prisma.customerPrice.upsert).toHaveBeenCalledTimes(2);
      expect(prisma.customerPrice.upsert).toHaveBeenLastCalledWith(
        expect.objectContaining({ update: expect.objectContaining({ pricingTier: 4, msrp: 5 }) }),
      );
    });
  });

  // ─── credit-note deletes must clear order↔credit-note links first ─────────
  // OrderCreditNote.creditNoteId has no onDelete (Restrict), so deleting a
  // credit note that is still linked to an order aborts the whole transaction.
  //
  // GREEN BY DESIGN — R0's fix is cherry-picked onto this branch (94e98afe,
  // retitled by d32a1fe5). The three REG-B189 describes below are ORDERING
  // pins that protect the picked fix from a later edit to any of the three
  // purge sites; they are NOT this batch's red, and a RED-gate run must not
  // count them as proof of F02b's own behavior changes.

  describe("REG-B189 deleteAllCustomers — order↔credit-note links", () => {
    it("deletes orderCreditNote rows for the customers' credit notes before the notes", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { id: "cust-1", userId: "user-1" },
        { id: "cust-2", userId: "user-2" },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([{ id: "cn-1" }, { id: "cn-2" }]);

      const result = await service.deleteAllCustomers();

      expect(result).toEqual({ deleted: 2 });
      expect(prisma.creditNote.findMany).toHaveBeenCalledWith({
        where: { customerId: { in: ["cust-1", "cust-2"] } },
        select: { id: true },
      });
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: { in: ["cn-1", "cn-2"] } },
      });
      expect(prisma.creditNote.deleteMany).toHaveBeenCalledWith({
        where: { customerId: { in: ["cust-1", "cust-2"] } },
      });
      const linkDelete = prisma.orderCreditNote.deleteMany.mock.invocationCallOrder[0];
      const noteDelete = prisma.creditNote.deleteMany.mock.invocationCallOrder[0];
      expect(linkDelete).toBeLessThan(noteDelete);
    });

    it("skips the link delete when the customers have no credit notes", async () => {
      prisma.customer.findMany.mockResolvedValue([{ id: "cust-1", userId: "user-1" }]);
      prisma.creditNote.findMany.mockResolvedValue([]);

      await service.deleteAllCustomers();

      expect(prisma.orderCreditNote.deleteMany).not.toHaveBeenCalled();
      expect(prisma.creditNote.deleteMany).toHaveBeenCalledWith({
        where: { customerId: { in: ["cust-1"] } },
      });
    });
  });

  // Green by design — R0's fix is cherry-picked (94e98afe); ordering pin, not this batch's red.
  describe("REG-B189 deleteCustomer (hard delete) — order↔credit-note links", () => {
    it("deletes orderCreditNote rows for the customer's credit notes before the notes", async () => {
      prisma.customer.findUnique.mockResolvedValue({
        ...MOCK_CUSTOMER,
        user: { status: "ACTIVE" },
      });
      // No orders/invoices/returns → the hard-delete path is taken (counts default to 0).
      prisma.creditNote.findMany.mockResolvedValue([{ id: "cn-9" }]);

      const result = await service.deleteCustomer("cust-1");

      expect(result).toEqual({ success: true });
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: { in: ["cn-9"] } },
      });
      const linkDelete = prisma.orderCreditNote.deleteMany.mock.invocationCallOrder[0];
      const noteDelete = prisma.creditNote.deleteMany.mock.invocationCallOrder[0];
      expect(linkDelete).toBeLessThan(noteDelete);
    });
  });

  // Green by design — R0's fix is cherry-picked (94e98afe); ordering pin, not this batch's red.
  describe("REG-B189 deleteImportedCustomers — order↔credit-note links", () => {
    it("deletes orderCreditNote rows for the imported customers' credit notes before the notes", async () => {
      prisma.customer.findMany.mockResolvedValue([
        { id: "cust-1", userId: "user-1", customerLink: null },
        { id: "cust-2", userId: "user-2", customerLink: { status: "ACTIVE" } },
      ]);
      prisma.creditNote.findMany.mockResolvedValue([{ id: "cn-3" }]);

      const result = await service.deleteImportedCustomers();

      expect(result).toEqual({ deleted: 1, preserved: 1 });
      expect(prisma.creditNote.findMany).toHaveBeenCalledWith({
        where: { customerId: { in: ["cust-1"] } },
        select: { id: true },
      });
      expect(prisma.orderCreditNote.deleteMany).toHaveBeenCalledWith({
        where: { creditNoteId: { in: ["cn-3"] } },
      });
      const linkDelete = prisma.orderCreditNote.deleteMany.mock.invocationCallOrder[0];
      const noteDelete = prisma.creditNote.deleteMany.mock.invocationCallOrder[0];
      expect(linkDelete).toBeLessThan(noteDelete);
    });
  });

  // ─── mergeCustomers: re-pointing + FK-violation guard (F02b R4 / B101) ─────────
  // createMockPrisma()'s tenantTransaction is a pass-through (`fn(models)`) and every
  // model method defaults to a benign resolved value that can never reject — a spec
  // built on that alone cannot tell a genuine re-point from a no-op, because
  // `customer.delete` would "succeed" either way (the vacuity trap, test-plan.md).
  // These specs instead give `customer.delete` a REAL in-memory relational check: it
  // throws the same Prisma-shaped P2003 Postgres itself raises whenever a row in a
  // tracked child table still points at the id being deleted. Re-pointing those rows
  // before the delete (or catching the residual violation) is therefore load-bearing —
  // a merge that skips it genuinely fails here, not merely on a mock inspected after
  // the fact.
  describe("mergeCustomers — re-pointing + FK-violation guard (F02b R4 / B101)", () => {
    const PRIMARY_ID = "cust-primary-b101";
    const SECONDARY_ID = "cust-secondary-b101";
    const PRIMARY = { id: PRIMARY_ID, userId: "user-p-b101" };
    const SECONDARY = { id: SECONDARY_ID, userId: "user-s-b101" };

    // The same shape Prisma.PrismaClientKnownRequestError carries for a foreign-key
    // RESTRICT violation (code P2003; meta.field_name names the failing constraint) —
    // see e.g. routes.service.ts's own `err?.code === "P2003"` handling.
    class FakeForeignKeyError extends Error {
      code = "P2003";
      meta: { field_name: string };
      constructor(fieldName: string) {
        super(`Foreign key constraint failed on the field: ${fieldName}`);
        this.meta = { field_name: fieldName };
      }
    }

    // Array-backed CRUD for one relation table, keyed by customerId, wired onto a
    // model's existing jest.fn()s — a re-point (update/updateMany to the primary) or a
    // drop (delete/deleteMany) is genuinely reflected in what customer.delete sees next.
    function relationRows<T extends { id: string; customerId: string }>(seed: T[]) {
      let rows = seed.map((r) => ({ ...r }));
      return {
        rows: () => rows,
        wire(mock: {
          findMany: jest.Mock;
          update: jest.Mock;
          updateMany: jest.Mock;
          delete: jest.Mock;
          deleteMany: jest.Mock;
        }) {
          mock.findMany.mockImplementation(async ({ where }: any = {}) =>
            rows.filter((r) => r.customerId === where?.customerId),
          );
          mock.update.mockImplementation(async ({ where, data }: any) => {
            const row = rows.find((r) => r.id === where.id);
            if (row) Object.assign(row, data);
            return row ?? null;
          });
          mock.updateMany.mockImplementation(async ({ where, data }: any) => {
            let count = 0;
            for (const r of rows) {
              if (r.customerId === where?.customerId) {
                Object.assign(r, data);
                count++;
              }
            }
            return { count };
          });
          mock.delete.mockImplementation(async ({ where }: any) => {
            const idx = rows.findIndex((r) => r.id === where.id);
            if (idx === -1) throw new Error("relationRows: no such row");
            const [removed] = rows.splice(idx, 1);
            return removed;
          });
          mock.deleteMany.mockImplementation(async ({ where }: any = {}) => {
            const before = rows.length;
            rows = rows.filter((r) => r.customerId !== where?.customerId);
            return { count: before - rows.length };
          });
        },
      };
    }

    beforeEach(() => {
      // These four models postdate createMockPrisma()'s model list (sales-agents /
      // buyer-portal features) — attached ad-hoc, same as the CUSTOMERS-soft-cap
      // `tenantSubscription` shim near the top of this file, rather than editing the
      // shared mock (out of this package's file scope).
      for (const m of [
        "agentAssignment",
        "commissionAccrual",
        "customerCommissionRate",
        "buyerPaymentRequest",
        "customerDocument",
      ]) {
        if (!(prisma as any)[m]) {
          (prisma as any)[m] = {
            findMany: jest.fn().mockResolvedValue([]),
            update: jest.fn().mockResolvedValue({}),
            updateMany: jest.fn().mockResolvedValue({ count: 0 }),
            delete: jest.fn().mockResolvedValue({}),
            deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
          };
        }
      }

      prisma.customer.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === PRIMARY_ID ? PRIMARY : where.id === SECONDARY_ID ? SECONDARY : null,
      );
      prisma.customerAuthorization.findMany.mockResolvedValue([]);

      // Rewire tenantTransaction to hand the callback THIS prisma object — the shared
      // mock's tenantTransaction closes over its OWN internal model list, captured
      // before the ad-hoc attachments above existed, so it would silently omit them.
      prisma.tenantTransaction.mockImplementation((fn: any) =>
        fn({
          ...(prisma as any),
          $executeRaw: jest.fn().mockResolvedValue(0),
          $queryRaw: jest.fn().mockResolvedValue([]),
        }),
      );
    });

    it("REG-B101a / T-B101a: re-points CustomerLink/AgentAssignment/CommissionAccrual/CustomerCommissionRate so customer.delete succeeds", async () => {
      const link = relationRows([{ id: "cl-1", customerId: SECONDARY_ID }]);
      const assign = relationRows([{ id: "aa-1", customerId: SECONDARY_ID }]);
      const accrual = relationRows([{ id: "ca-1", customerId: SECONDARY_ID }]);
      const rate = relationRows([{ id: "ccr-1", customerId: SECONDARY_ID }]);
      link.wire(prisma.customerLink as any);
      assign.wire((prisma as any).agentAssignment);
      accrual.wire((prisma as any).commissionAccrual);
      rate.wire((prisma as any).customerCommissionRate);

      // RESTRICT is the schema default for all four (no onDelete override in
      // schema.prisma) — the delete fails whenever any of them still points at the id
      // being deleted, exactly like Postgres would.
      prisma.customer.delete.mockImplementation(async ({ where }: any) => {
        for (const [name, store] of [
          ["CustomerLink", link],
          ["AgentAssignment", assign],
          ["CommissionAccrual", accrual],
          ["CustomerCommissionRate", rate],
        ] as const) {
          if (store.rows().some((r) => r.customerId === where.id)) {
            throw new FakeForeignKeyError(`${name}_customerId_fkey (index)`);
          }
        }
        return {};
      });

      // Asserted rather than bare-awaited so today's failure reads as an
      // ASSERTION ("merge rejected with P2003" against an expected resolve)
      // instead of an uncaught FakeForeignKeyError escaping the test body —
      // the two are indistinguishable in a gate report, and only one of them
      // says "the behavior is missing" rather than "the fixture is broken".
      // mergeCustomers resolves with the reloaded primary customer, so
      // toBeDefined() is satisfied by the real return value on green.
      await expect(service.mergeCustomers(PRIMARY_ID, SECONDARY_ID)).resolves.toBeDefined();

      expect(link.rows().find((r) => r.id === "cl-1")?.customerId).toBe(PRIMARY_ID);
      expect(assign.rows().find((r) => r.id === "aa-1")?.customerId).toBe(PRIMARY_ID);
      expect(accrual.rows().find((r) => r.id === "ca-1")?.customerId).toBe(PRIMARY_ID);
      expect(rate.rows().find((r) => r.id === "ccr-1")?.customerId).toBe(PRIMARY_ID);
      expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: SECONDARY_ID } });
    });

    it("REG-B101b / T-B101b: re-points BuyerPaymentRequest/CustomerDocument/RouteRunStop without ever deleting the RouteRunStop rows", async () => {
      const bpr = relationRows([{ id: "bpr-1", customerId: SECONDARY_ID }]);
      const doc = relationRows([{ id: "doc-1", customerId: SECONDARY_ID }]);
      const stops = relationRows([
        { id: "rrs-1", customerId: SECONDARY_ID, routeStopId: "rs-1" },
        { id: "rrs-2", customerId: SECONDARY_ID, routeStopId: "rs-2" },
      ]);
      // The RouteStop parents those run stops hang off. RouteRunStop.routeStopId is a
      // required relation with no onDelete override, i.e. ON DELETE RESTRICT
      // (0_init/migration.sql) — so once the run stops are re-pointed rather than
      // deleted, dropping their parents raises P2003 and rolls the merge back.
      const parents = relationRows([
        { id: "rs-1", customerId: SECONDARY_ID },
        { id: "rs-2", customerId: SECONDARY_ID },
      ]);
      bpr.wire((prisma as any).buyerPaymentRequest);
      doc.wire((prisma as any).customerDocument);
      stops.wire(prisma.routeRunStop as any);
      parents.wire(prisma.routeStop as any);
      const dropParents = (prisma.routeStop.deleteMany as jest.Mock).getMockImplementation()!;
      (prisma.routeStop.deleteMany as jest.Mock).mockImplementation(async (args: any) => {
        const doomed = parents.rows().filter((p) => p.customerId === args?.where?.customerId);
        if (stops.rows().some((rr) => doomed.some((p) => p.id === rr.routeStopId))) {
          throw new FakeForeignKeyError("RouteRunStop_routeStopId_fkey (index)");
        }
        return dropParents(args);
      });

      // Asserted, not bare-awaited: a bare `await` on a rejecting merge surfaces as an
      // uncaught ERROR instead of an assertion failure, which reads as an infrastructure
      // problem rather than the regression this test exists to catch (same guard as B101a).
      await expect(service.mergeCustomers(PRIMARY_ID, SECONDARY_ID)).resolves.toBeDefined();

      expect(bpr.rows().find((r) => r.id === "bpr-1")?.customerId).toBe(PRIMARY_ID);
      expect(doc.rows().find((r) => r.id === "doc-1")?.customerId).toBe(PRIMARY_ID);
      expect(stops.rows().map((r) => r.customerId)).toEqual([PRIMARY_ID, PRIMARY_ID]);
      // B101's original bug: an unconditional deleteMany here destroyed delivered-run
      // photos/signatures instead of leaving the POD rows intact under the primary.
      expect(prisma.routeRunStop.deleteMany).not.toHaveBeenCalled();
      // …and the parent RouteStops must be re-pointed too, not deleted: deleting them
      // while the re-pointed run stops still reference them is a RESTRICT violation
      // that would 409 the whole merge for any customer with delivery history.
      expect(parents.rows().map((r) => r.customerId)).toEqual([PRIMARY_ID, PRIMARY_ID]);
      expect(prisma.routeStop.deleteMany).not.toHaveBeenCalled();
    });

    it("REG-B101c / T-B101c: an unresolvable Restrict relation surfaces as a named ConflictException, not a raw 500", async () => {
      // Models a residual FK the merge's known re-point list cannot possibly cover — a
      // schema addition still to come. Proves the guard is generic: ANY leftover P2003
      // at delete time is caught and turned into a 409 naming the relation from the
      // real Prisma error's meta.field_name, never left to bubble up as a raw crash.
      prisma.customer.delete.mockImplementation(async () => {
        throw new FakeForeignKeyError("LoyaltyPointsLedger_customerId_fkey (index)");
      });

      let caught: any;
      try {
        await service.mergeCustomers(PRIMARY_ID, SECONDARY_ID);
      } catch (e) {
        caught = e;
      }

      expect(caught).toBeInstanceOf(ConflictException);
      expect(caught.message).toContain("LoyaltyPointsLedger");
    });
  });

  // ─── deleteCustomer: `force` stays reversible for HTTP callers (F02b R5 / B130) ──
  describe("deleteCustomer — force=true is the web's reversible soft-delete (F02b R5 / B130)", () => {
    const CUSTOMER = { id: "cust-force-b130", userId: "user-force-b130" };

    beforeEach(() => {
      prisma.customer.findUnique.mockImplementation(async ({ where }: any) =>
        where.id === CUSTOMER.id ? { ...CUSTOMER, user: { status: "ACTIVE" } } : null,
      );
      // Record-free: nothing to orphan, so the 409 never fires either way.
      prisma.order.count.mockResolvedValue(0);
      prisma.invoice.count.mockResolvedValue(0);
      prisma.return.count.mockResolvedValue(0);
    });

    it("REG-B130b: soft-deletes a RECORD-FREE customer when force=true (the detail page's Undo contract)", async () => {
      // DELETE /customers/:id?force=true is the only delete on the customer detail
      // page (useSoftDeleteCustomer), and its 8-second Undo calls
      // POST /customers/:id/restore — so force must never hard-delete, not even for
      // a customer with no orders/invoices/returns, or the Undo 404s against a row
      // that no longer exists.
      await expect(service.deleteCustomer(CUSTOMER.id, true)).resolves.toEqual({
        success: true,
        softDeleted: true,
      });

      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: CUSTOMER.id },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.customer.delete).not.toHaveBeenCalled();
      expect(prisma.user.delete).not.toHaveBeenCalled();
    });

    it("REG-B130b: hard-deletes a record-free customer when the caller opts into hardDeleteWhenRecordFree", async () => {
      // batchDelete's narrowing — force means "waive the 409 only" there, so an
      // empty customer is genuinely removed (T-B130a's customer Z).
      await expect(
        service.deleteCustomer(CUSTOMER.id, true, { hardDeleteWhenRecordFree: true }),
      ).resolves.toEqual({ success: true });

      expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: CUSTOMER.id } });
      expect(prisma.customer.update).not.toHaveBeenCalledWith({
        where: { id: CUSTOMER.id },
        data: { deletedAt: expect.any(Date) },
      });
    });
  });

  // ─── batchDelete: force pass-through for record-holding customers (F02b R5 / B130) ──
  describe("batchDelete — force pass-through for record-holding customers (F02b R5 / B130)", () => {
    const CUSTOMER_X = { id: "cust-x-b130", userId: "user-x-b130" };
    const CUSTOMER_Y = { id: "cust-y-b130", userId: "user-y-b130" };
    const CUSTOMER_Z = { id: "cust-z-b130", userId: "user-z-b130" };

    // R5's contract, precisely: `force` lifts the 409 pre-flight ONLY. The soft-vs-hard
    // choice stays keyed on whether the customer actually holds records, which is why
    // batchDelete opts in with `{ hardDeleteWhenRecordFree: true }` — a blanket "force means
    // soft-delete everything" would leave Z as a ghost row and the assertion on
    // `customer.delete` below is the only thing that tells the two apart.
    it("REG-B130a / T-B130a: soft-deletes a record-holding customer (Y), hard-deletes a record-free one (Z); a PAID-invoice customer (X) still 409s pre-flight", async () => {
      // Whole-batch pre-flight: blocked only when a PAID/SENT invoice is in the set.
      prisma.invoice.groupBy.mockImplementation(async ({ where }: any) => {
        const ids: string[] = where.customerId.in;
        return ids.includes(CUSTOMER_X.id)
          ? [{ customerId: CUSTOMER_X.id, _count: { _all: 1 } }]
          : [];
      });

      await expect(service.batchDelete([CUSTOMER_X.id, CUSTOMER_Y.id])).rejects.toThrow(
        ConflictException,
      );

      prisma.customer.findUnique.mockImplementation(async ({ where }: any) => {
        if (where.id === CUSTOMER_Y.id) return { ...CUSTOMER_Y, user: { status: "ACTIVE" } };
        if (where.id === CUSTOMER_Z.id) return { ...CUSTOMER_Z, user: { status: "ACTIVE" } };
        return null;
      });
      // Y has orders (no PAID/SENT invoices — that's what let it past the pre-flight
      // above); Z has no records at all.
      prisma.order.count.mockImplementation(async ({ where }: any) =>
        where.customerId === CUSTOMER_Y.id ? 3 : 0,
      );
      prisma.invoice.count.mockResolvedValue(0);
      prisma.return.count.mockResolvedValue(0);

      const result = await service.batchDelete([CUSTOMER_Y.id, CUSTOMER_Z.id]);

      expect(result).toEqual({ deleted: 2, failed: [] });

      // Y: soft-deleted — deletedAt set, never hard-deleted, its 3 orders untouched.
      expect(prisma.customer.update).toHaveBeenCalledWith({
        where: { id: CUSTOMER_Y.id },
        data: { deletedAt: expect.any(Date) },
      });
      expect(prisma.customer.delete).not.toHaveBeenCalledWith({ where: { id: CUSTOMER_Y.id } });

      // Z: no records — hard-deleted.
      expect(prisma.customer.delete).toHaveBeenCalledWith({ where: { id: CUSTOMER_Z.id } });
    });
  });
});
