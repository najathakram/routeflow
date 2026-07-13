import { Test, TestingModule } from "@nestjs/testing";
import { NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { CustomersService } from "./customers.service";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
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

  beforeEach(async () => {
    prisma = createMockPrisma();

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
});
