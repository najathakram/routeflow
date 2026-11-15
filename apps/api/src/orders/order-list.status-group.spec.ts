/**
 * UX guide B12: the buyer's "Active" orders tab asks for a status GROUP, not one status. The server builds the
 * filter (one shared list), the client only picks the group. An explicit `status` still wins.
 */
import { UserRole } from "@prisma/client";
import { findAllOrdersImpl } from "./order-list";
import type { ListOrdersDto } from "./dto/list-orders.dto";

function setup() {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const prisma: any = {
    getTenantId: () => "t1",
    forTenant: () => ({
      customer: { findFirst: jest.fn().mockResolvedValue({ id: "cust-1" }) },
      order: { findMany, count },
    }),
  };
  const user: any = { sub: "u1", role: UserRole.CUSTOMER, tenantId: "t1" };
  const run = (q: Record<string, unknown>) =>
    findAllOrdersImpl(prisma, q as unknown as ListOrdersDto, user);
  return { findMany, run };
}

describe("findAllOrdersImpl statusGroup (UX guide B12)", () => {
  it("ACTIVE filters to the four in-progress statuses and keeps the customer scope", async () => {
    const { findMany, run } = setup();
    await run({ statusGroup: "ACTIVE" });
    const where = findMany.mock.calls[0][0].where;
    expect(where.customerId).toBe("cust-1");
    expect(where.status).toEqual({
      in: ["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "PARTIALLY_DELIVERED"],
    });
  });

  it("guard: an explicit status wins over the group", async () => {
    const { findMany, run } = setup();
    await run({ status: "CONFIRMED", statusGroup: "ACTIVE" });
    expect(findMany.mock.calls[0][0].where.status).toBe("CONFIRMED");
  });
});
