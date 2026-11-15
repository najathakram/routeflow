import { Logger } from "@nestjs/common";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { OperatorPermissionsService } from "./operator-permissions.service";
import { priceEditAllowedFor } from "./price-edit";

type Row = { deniedPermissionGroups: OperatorPermissionGroup[]; permissionsVersion: number } | null;

function setup(row: Row | Error) {
  const findFirst = jest.fn(async () => {
    if (row instanceof Error) throw row;
    return row;
  });
  return { prisma: { user: { findFirst } } as never, findFirst };
}
const principal = (role: UserRole) => ({ sub: "u1", tenantId: "t1", role });
const DENY_PRICING: Row = {
  deniedPermissionGroups: [OperatorPermissionGroup.PRICING],
  permissionsVersion: 1,
};
const DENY_NONE: Row = { deniedPermissionGroups: [], permissionsVersion: 1 };

/**
 * W-870 (SA-1145): the price right is enforced at every site, whatever the global permissions mode. The mode stays
 * "shadow" (it is not read here); the denied groups are read live and a failed read fails closed.
 */
describe("priceEditAllowedFor (one capability, enforced at every site)", () => {
  let warn: jest.SpyInstance;
  let mode: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    mode = jest.spyOn(OperatorPermissionsService.prototype, "mode").mockReturnValue("shadow");
  });
  afterEach(() => jest.restoreAllMocks());

  it("an operator denied PRICING is refused while the global mode is shadow; one deny line names group, site and tenant only", async () => {
    const { prisma } = setup(DENY_PRICING);
    await expect(
      priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "Site.edit"),
    ).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith("denied groups=PRICING handler=Site.edit tenant=t1");
  });

  it("an operator with PRICING is allowed with no log", async () => {
    const { prisma } = setup(DENY_NONE);
    await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
      true,
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("an operator with no user row holds nothing, so is refused (fail closed)", async () => {
    const { prisma } = setup(null);
    await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
      false,
    );
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("a failed deny-list read throws and writes no allow log (fails closed)", async () => {
    const { prisma } = setup(new Error("db down"));
    await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).rejects.toThrow(
      "db down",
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("the global permissions mode is never read", async () => {
    const { prisma } = setup(DENY_NONE);
    await priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s");
    expect(mode).not.toHaveBeenCalled();
  });

  it("TENANT_ADMIN is allowed with no read", async () => {
    const { prisma, findFirst } = setup(DENY_PRICING);
    await expect(priceEditAllowedFor(prisma, principal(UserRole.TENANT_ADMIN), "s")).resolves.toBe(
      true,
    );
    expect(findFirst).not.toHaveBeenCalled();
  });

  it.each([UserRole.SUPER_ADMIN, UserRole.DRIVER, UserRole.CUSTOMER])(
    "%s never edits a line price, with no read",
    async (role) => {
      const { prisma, findFirst } = setup(DENY_NONE);
      await expect(priceEditAllowedFor(prisma, principal(role), "s")).resolves.toBe(false);
      expect(findFirst).not.toHaveBeenCalled();
    },
  );

  it("no principal is refused with no read", async () => {
    const { prisma, findFirst } = setup(DENY_NONE);
    await expect(priceEditAllowedFor(prisma, undefined, "s")).resolves.toBe(false);
    await expect(priceEditAllowedFor(prisma, null, "s")).resolves.toBe(false);
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("reads the deny list once per call", async () => {
    const { prisma, findFirst } = setup(DENY_NONE);
    await priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
