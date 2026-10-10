import { WalkInCustomerService } from "./walk-in-customer";
import { createMockPrisma } from "../../testing/prisma-mock";

/**
 * The walk-in customer (SA-655): ONE system customer per tenant, created lazily by the first counter
 * sale and reused by every later one. Race-safe through User @@unique([tenantId, username]).
 */
describe("WalkInCustomerService.getOrCreateWalkIn", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: WalkInCustomerService;
  const created: { user?: any; customer?: any } = {};
  let customers: { restoreCustomer: jest.Mock };

  beforeEach(() => {
    prisma = createMockPrisma();
    created.user = undefined;
    created.customer = undefined;
    prisma.customer.findFirst.mockResolvedValue(null);
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        user: {
          create: jest.fn(async ({ data }: any) => {
            created.user = data;
            return { id: "user-w", ...data };
          }),
        },
        customer: {
          create: jest.fn(async ({ data }: any) => {
            created.customer = data;
            return { id: "cust-w", ...data };
          }),
        },
      }),
    );
    // Constructed with ONLY the prisma service: the customer cap gate is deliberately not a dependency.
    customers = { restoreCustomer: jest.fn().mockResolvedValue({ success: true, restored: true }) };
    service = new WalkInCustomerService(prisma as never, customers as never);
  });

  it("creates the system user + customer once, with an unusable password and no status emails", async () => {
    await expect(service.getOrCreateWalkIn()).resolves.toBe("cust-w");
    expect(created.user).toMatchObject({
      role: "CUSTOMER",
      username: "walk-in-counter",
      forcePasswordChange: false,
    });
    expect(created.user.email).toMatch(/^no-email\+[0-9a-f-]+@placeholder\.local$/);
    expect(typeof created.user.password).toBe("string");
    expect(created.user.password).toMatch(/^\$2[aby]\$/); // a bcrypt hash of a random, discarded secret
    expect(created.customer).toMatchObject({
      userId: "user-w",
      businessName: "Walk-in customer",
      contactName: "Walk-in",
      isWalkIn: true,
      orderStatusEmails: false,
    });
  });

  it("reuses the existing walk-in customer and writes nothing", async () => {
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-existing" });
    await expect(service.getOrCreateWalkIn()).resolves.toBe("cust-existing");
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ isWalkIn: true }) }),
    );
  });

  it("two sales: the first creates, the second finds it", async () => {
    await service.getOrCreateWalkIn();
    prisma.customer.findFirst.mockResolvedValue({ id: "cust-w" });
    await service.getOrCreateWalkIn();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });

  it("a P2002 on the username (a concurrent first sale won) re-finds the winner: still one row", async () => {
    (prisma.tenantTransaction as jest.Mock).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    prisma.customer.findFirst
      .mockResolvedValueOnce(null) // the pre-check
      .mockResolvedValueOnce({ id: "cust-winner" }); // the re-find
    await expect(service.getOrCreateWalkIn()).resolves.toBe("cust-winner");
  });

  it("a P2002 with no winner to find is rethrown, never a second walk-in", async () => {
    (prisma.tenantTransaction as jest.Mock).mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    await expect(service.getOrCreateWalkIn()).rejects.toMatchObject({ code: "P2002" });
  });

  it("a soft-deleted walk-in is RESTORED (CustomersService.restoreCustomer), never a 500 or a second walk-in", async () => {
    prisma.customer.findFirst
      .mockResolvedValueOnce(null) // no live walk-in
      .mockResolvedValueOnce({ id: "cust-deleted" }); // a removed one
    await expect(service.getOrCreateWalkIn()).resolves.toBe("cust-deleted");
    expect(customers.restoreCustomer).toHaveBeenCalledWith("cust-deleted");
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.customer.findFirst.mock.calls[1][0].where).toMatchObject({
      isWalkIn: true,
      deletedAt: { not: null },
    });
  });

  it("a live walk-in wins over a removed one and nothing is restored", async () => {
    prisma.customer.findFirst.mockResolvedValueOnce({ id: "cust-live" });
    await expect(service.getOrCreateWalkIn()).resolves.toBe("cust-live");
    expect(customers.restoreCustomer).not.toHaveBeenCalled();
  });

  it("reads and writes through the tenant-scoped client / tenantTransaction", async () => {
    await service.getOrCreateWalkIn();
    expect(prisma.forTenant).toHaveBeenCalled();
    expect(prisma.tenantTransaction).toHaveBeenCalledTimes(1);
  });
});
