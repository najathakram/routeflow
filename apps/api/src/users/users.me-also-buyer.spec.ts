import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

/**
 * W-839 / SA-937 MUSTs 1, 2, 4: `alsoBuyer` rides GET /users/me only. It is computed in a getMe path from the user's
 * STORED email and tenant (never the request), and findById, which also serves admins' GET /users/:id, never carries it.
 */
const row = {
  id: "u1",
  tenantId: "t1",
  email: "Sam@Acme.example",
  role: "DRIVER",
  password: "hash",
  googleId: null,
  deniedPermissionGroups: [],
  permissionsVersion: 1,
};

function fakeSelf(linkFound: boolean) {
  const findFirst = jest.fn().mockResolvedValue(linkFound ? { id: "link-1" } : null);
  const prisma = {
    forTenant: () => ({
      user: { findUnique: jest.fn().mockResolvedValue(row) },
      customerLink: { findFirst },
    }),
  };
  const self: any = { prisma };
  self.findById = (UsersService.prototype as any).findById.bind(self);
  return { self, findFirst };
}

describe("GET /users/me carries alsoBuyer; GET /users/:id never does", () => {
  it("getMe adds alsoBuyer, judged on the stored email and tenant", async () => {
    const { self, findFirst } = fakeSelf(true);
    const me = await (UsersService.prototype as any).getMe.call(self, "u1");
    expect(me.alsoBuyer).toBe(true);
    expect(findFirst.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        tenantId: "t1",
        buyerAccount: expect.objectContaining({
          email: { equals: "Sam@Acme.example", mode: "insensitive" },
        }),
      }),
    );
    expect(me).not.toHaveProperty("password");
  });

  it("getMe is false when no link matches, and a boolean only (no buyer id, name, customer or count)", async () => {
    const { self } = fakeSelf(false);
    const me = await (UsersService.prototype as any).getMe.call(self, "u1");
    expect(me.alsoBuyer).toBe(false);
    for (const k of Object.keys(me))
      expect(k).not.toMatch(/buyer(Id|Account|Name)|linkedCustomer|buyerCount/i);
  });

  it("findById (GET /users/:id) has no alsoBuyer key and never queries links", async () => {
    const { self, findFirst } = fakeSelf(true);
    const user = await (UsersService.prototype as any).findById.call(self, "u1");
    expect(user).not.toHaveProperty("alsoBuyer");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("the user list (findAll) never carries alsoBuyer and never queries links (SA-937 MUST 2)", async () => {
    const findFirst = jest.fn();
    const prisma = {
      forTenant: () => ({
        user: {
          findMany: jest.fn().mockResolvedValue([row]),
          count: jest.fn().mockResolvedValue(1),
        },
        customerLink: { findFirst },
      }),
    };
    const out = await (UsersService.prototype as any).findAll.call({ prisma }, {}, "TENANT_ADMIN");
    const rows: unknown[] = out?.data ?? out;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r).not.toHaveProperty("alsoBuyer");
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("the controller: /me goes through getMe, /:id through findById", async () => {
    const usersService = {
      getMe: jest.fn().mockResolvedValue({ alsoBuyer: true }),
      findById: jest.fn(),
    };
    const ctl: any = { usersService };
    const caller = { sub: "u1", role: "OPERATOR", tenantId: "t1" };
    await (UsersController.prototype as any).getMe.call(ctl, caller);
    expect(usersService.getMe).toHaveBeenCalledWith("u1");
    await (UsersController.prototype as any).findOne.call(ctl, "u2", caller);
    expect(usersService.findById).toHaveBeenCalledWith("u2");
  });
});
