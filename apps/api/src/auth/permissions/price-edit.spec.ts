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

describe("priceEditAllowedFor (SA-1034: one capability, mode-aware)", () => {
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;
  let mode: jest.SpyInstance;
  beforeEach(() => {
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    mode = jest.spyOn(OperatorPermissionsService.prototype, "mode").mockReturnValue("shadow");
  });
  afterEach(() => jest.restoreAllMocks());

  describe("shadow (the shipped mode)", () => {
    it("an operator denied PRICING is still allowed, and one would-deny line names group, site and tenant only", async () => {
      const { prisma } = setup(DENY_PRICING);
      await expect(
        priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "Site.edit"),
      ).resolves.toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith("would-deny groups=PRICING handler=Site.edit tenant=t1");
    });

    it("an operator with PRICING is allowed with no log", async () => {
      const { prisma } = setup(DENY_NONE);
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
        true,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("a failed deny-list read allows by the role and logs an error (observe, never block)", async () => {
      const { prisma } = setup(new Error("db down"));
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
        true,
      );
      expect(error).toHaveBeenCalledTimes(1);
      expect(String(error.mock.calls[0][0])).toContain("handler=s tenant=t1");
    });
  });

  describe("live (the owner's later flip)", () => {
    beforeEach(() => mode.mockReturnValue("live"));

    it("an operator denied PRICING is refused, with no log", async () => {
      const { prisma } = setup(DENY_PRICING);
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
        false,
      );
      expect(warn).not.toHaveBeenCalled();
    });

    it("an operator with PRICING is allowed", async () => {
      const { prisma } = setup(DENY_NONE);
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
        true,
      );
    });

    it("an operator with no user row holds nothing, so is refused (fail closed)", async () => {
      const { prisma } = setup(null);
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).resolves.toBe(
        false,
      );
    });

    it("a failed deny-list read throws (fails closed)", async () => {
      const { prisma } = setup(new Error("db down"));
      await expect(priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s")).rejects.toThrow(
        "db down",
      );
    });
  });

  describe.each(["shadow", "live"] as const)("%s: roles that never read the deny list", (m) => {
    beforeEach(() => mode.mockReturnValue(m));

    it("TENANT_ADMIN is allowed with no read, whatever the mode", async () => {
      const { prisma, findFirst } = setup(DENY_PRICING);
      await expect(
        priceEditAllowedFor(prisma, principal(UserRole.TENANT_ADMIN), "s"),
      ).resolves.toBe(true);
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
  });

  it("reads the deny list once per call", async () => {
    const { prisma, findFirst } = setup(DENY_NONE);
    await priceEditAllowedFor(prisma, principal(UserRole.OPERATOR), "s");
    expect(findFirst).toHaveBeenCalledTimes(1);
  });
});
