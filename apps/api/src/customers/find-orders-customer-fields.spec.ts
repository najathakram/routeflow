import { CustomersService } from "./customers.service";

/**
 * GET /customers/:id/orders is CUSTOMER-reachable (own customer only). Its rows carry
 * customer-facing fields only for the customer; staff rows are unchanged. Placeholders only.
 */
const row = () => ({
  id: "ord-1",
  customerId: "cust-1",
  status: "DELIVERED",
  commissionRatePct: 7.5,
  total: 20,
});

function serviceReading(orders: object[]) {
  const service = Object.assign(Object.create(CustomersService.prototype), {
    prisma: {
      forTenant: () => ({
        customer: {
          findUnique: jest.fn().mockResolvedValue({ id: "cust-1", userId: "user-cust" }),
        },
        order: {
          findMany: jest.fn().mockResolvedValue(orders),
          count: jest.fn().mockResolvedValue(orders.length),
        },
      }),
    },
  }) as CustomersService;
  return service;
}

const principal = (role: string, sub: string) =>
  ({ sub, username: "u", role, status: "ACTIVE", forcePasswordChange: false }) as never;

describe("CustomersService.findOrders — customer-facing fields only", () => {
  it("staff: rows come back exactly as read", async () => {
    const out = await serviceReading([row()]).findOrders("cust-1", principal("OPERATOR", "u-op"));
    expect(out.data).toEqual([row()]);
  });

  it("customer: no commission rate", async () => {
    const out = await serviceReading([row()]).findOrders(
      "cust-1",
      principal("CUSTOMER", "user-cust"),
    );
    expect(out.data[0]).not.toHaveProperty("commissionRatePct");
    expect(out.data[0]).toEqual({
      id: "ord-1",
      customerId: "cust-1",
      status: "DELIVERED",
      total: 20,
    });
  });
});
