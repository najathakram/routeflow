import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { findAllOrdersImpl } from "../order-list";

const staff = (over: Partial<JwtPayload> = {}) =>
  ({ sub: "u1", role: "OPERATOR", tenantId: "t1", ...over }) as JwtPayload;

/** Minimal prisma: only what the list reads; `where` is what the list handed to findMany. */
const world = (tenantOfRequest: string | null = "t-request") => {
  const findMany = jest.fn().mockResolvedValue([]);
  const count = jest.fn().mockResolvedValue(0);
  const getTenantId = jest.fn().mockReturnValue(tenantOfRequest);
  const prisma = { forTenant: () => ({ order: { findMany, count } }), getTenantId } as never;
  return { prisma, findMany, getTenantId };
};
const whereOf = (findMany: jest.Mock) => findMany.mock.calls[0][0].where;

describe("findAllOrdersImpl: needsReview passes the tenant to the relation filter (SA-1124 S2)", () => {
  it("a staff token's tenant scopes the open-flag filter", async () => {
    const { prisma, findMany } = world();
    await findAllOrdersImpl(prisma, { needsReview: true } as never, staff());
    expect(whereOf(findMany).reviewFlags).toEqual({ some: { tenantId: "t1", resolvedAt: null } });
  });

  it("a token without a tenant (super admin) takes the request's tenant", async () => {
    const { prisma, findMany } = world("t-request");
    await findAllOrdersImpl(prisma, { needsReview: true } as never, staff({ tenantId: null }));
    expect(whereOf(findMany).reviewFlags).toEqual({
      some: { tenantId: "t-request", resolvedAt: null },
    });
  });

  it("without needsReview there is no flag filter and the request tenant is not even read", async () => {
    const { prisma, findMany, getTenantId } = world();
    await findAllOrdersImpl(prisma, {} as never, staff());
    expect(whereOf(findMany)).not.toHaveProperty("reviewFlags");
    expect(getTenantId).not.toHaveBeenCalled();
  });

  it("a driver's list is never filtered by flags", async () => {
    const { prisma, findMany } = world();
    await findAllOrdersImpl(prisma, { needsReview: true } as never, staff({ role: "DRIVER" }));
    expect(whereOf(findMany)).not.toHaveProperty("reviewFlags");
  });
});
