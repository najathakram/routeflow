import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { MeterService } from "../billing/meter.service";
import { PlanCatalogService } from "../billing/plan-catalog.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

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

  beforeEach(async () => {
    prisma = createMockPrisma();
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomersService,
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
        { provide: MeterService, useValue: meter },
        { provide: PlanCatalogService, useValue: catalog },
        // flag.msrp defaults OFF — msrp-free upserts never consult the flag.
        {
          provide: EntitlementsService,
          useValue: { hasFlag: jest.fn().mockResolvedValue(false) },
        },
      ],
    }).compile();

    service = module.get<CustomersService>(CustomersService);
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

    it("getIncomeChart: the monthly-income query filters out VOID payments", async () => {
      prisma.customer.findUnique.mockResolvedValue(MOCK_CUSTOMER);
      prisma.invoicePayment.findMany.mockResolvedValue([]);
      prisma.expense.findMany.mockResolvedValue([]);

      await service.getIncomeChart("cust-1");

      expect(prisma.invoicePayment.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { not: "VOID" } }),
        }),
      );
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

    it("a DRIVER may still null the tier on a row that keeps its MSRP (no delete involved)", async () => {
      prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 });
      prisma.customerPrice.upsert.mockResolvedValue({ id: "cp-1" });

      await service.upsertCustomerPrice(
        "cust-1",
        { productId: "p1", pricingTier: null },
        driverPayload,
      );

      expect(prisma.customerPrice.delete).not.toHaveBeenCalled();
      expect(prisma.customerPrice.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({ pricingTier: null, msrp: 5 }),
        }),
      );
    });
  });
});
