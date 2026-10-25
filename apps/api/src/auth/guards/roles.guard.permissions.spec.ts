import { ExecutionContext, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { Roles } from "../decorators/roles.decorator";
import { PermissionBase, RequirePermission } from "../permissions/permission.decorators";
import { OperatorPermissionsService } from "../permissions/operator-permissions.service";
import { RolesGuard } from "./roles.guard";

/**
 * Operator permissions PR3 (shadow): `RolesGuard` stays the one guard. After the role check passes, an OPERATOR on a
 * handler that names permission groups must hold at least one of them. In SHADOW mode (this release) a miss is logged as
 * `would-deny` and ALLOWED; in LIVE mode it is 403 PERMISSION_DENIED. TENANT_ADMIN and SUPER_ADMIN pass without a database
 * read; DRIVER and CUSTOMER are never permission-checked. A handler with no permission metadata behaves exactly as before.
 */
class Ctl {
  @Roles(UserRole.OPERATOR)
  plain() {
    return 1;
  }
  @Roles(UserRole.OPERATOR)
  @RequirePermission("ORDERS", "FINANCE")
  orders() {
    return 1;
  }
  @Roles(UserRole.OPERATOR)
  @PermissionBase("product picker is read at sale time")
  lookup() {
    return 1;
  }
  @Roles(UserRole.TENANT_ADMIN)
  admin() {
    return 1;
  }
  @Roles(UserRole.OPERATOR, UserRole.DRIVER)
  @RequirePermission("ORDERS")
  shared() {
    return 1;
  }
}

@RequirePermission("FINANCE")
class GroupedCtl {
  @Roles(UserRole.OPERATOR)
  inherits() {
    return 1;
  }
  @Roles(UserRole.OPERATOR)
  @PermissionBase("a lookup")
  baseOverride() {
    return 1;
  }
  @Roles(UserRole.OPERATOR)
  @RequirePermission("ORDERS")
  groupOverride() {
    return 1;
  }
}

const ctxFor = (method: keyof Ctl, user: Record<string, unknown>) =>
  ({
    getHandler: () => Ctl.prototype[method],
    getClass: () => Ctl,
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

const OPERATOR = { sub: "u1", tenantId: "t1", role: UserRole.OPERATOR };

describe("RolesGuard + operator permission groups", () => {
  let held: OperatorPermissionGroup[];
  let mode: "shadow" | "live";
  let effective: jest.Mock;
  let guard: RolesGuard;
  let warn: jest.SpyInstance;

  beforeEach(() => {
    held = Object.values(OperatorPermissionGroup);
    mode = "shadow";
    effective = jest.fn(async () => ({ groups: held, version: 1 }));
    const perms = {
      effective,
      mode: () => mode,
      hasAny: async (user: unknown, groups: string[]) =>
        (await effective(user)).groups.some((g: string) => groups.includes(g)),
    } as unknown as OperatorPermissionsService;
    guard = new RolesGuard(new Reflector(), perms);
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it("a handler with no permission metadata is the plain role check, synchronously, no lookup", () => {
    expect(guard.canActivate(ctxFor("plain", OPERATOR))).toBe(true);
    expect(guard.canActivate(ctxFor("lookup", OPERATOR))).toBe(true); // PermissionBase: any operator
    expect(effective).not.toHaveBeenCalled();
  });

  it("an operator holding any of the named groups passes", async () => {
    held = ["FINANCE"];
    await expect(guard.canActivate(ctxFor("orders", OPERATOR))).resolves.toBe(true);
    expect(warn).not.toHaveBeenCalled();
  });

  it("SHADOW: an operator holding none is ALLOWED and one would-deny line is logged", async () => {
    held = ["CATALOG"];
    await expect(guard.canActivate(ctxFor("orders", OPERATOR))).resolves.toBe(true);
    const lines = warn.mock.calls.map((c) => String(c[0])).filter((l) => /would-deny/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/groups=ORDERS\|FINANCE/);
    expect(lines[0]).toMatch(/handler=Ctl\.orders/);
  });

  it("LIVE: an operator holding none is 403 PERMISSION_DENIED naming the groups that would open it", async () => {
    mode = "live";
    held = ["CATALOG"];
    const err: any = await Promise.resolve(guard.canActivate(ctxFor("orders", OPERATOR))).catch(
      (e) => e,
    );
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.PERMISSION_DENIED,
      groups: ["ORDERS", "FINANCE"],
    });
  });

  it("LIVE: every group on still passes", async () => {
    mode = "live";
    await expect(guard.canActivate(ctxFor("orders", OPERATOR))).resolves.toBe(true);
  });

  it("TENANT_ADMIN and SUPER_ADMIN pass a grouped handler without any lookup", () => {
    mode = "live";
    held = [];
    for (const role of [UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN]) {
      expect(guard.canActivate(ctxFor("orders", { sub: "a", tenantId: "t1", role }))).toBe(true);
    }
    expect(effective).not.toHaveBeenCalled();
  });

  it("an operator who can act as a driver is STILL permission-checked on a shared handler (no driver exemption)", async () => {
    mode = "live";
    held = [];
    const err: any = await Promise.resolve(
      guard.canActivate(ctxFor("shared", { ...OPERATOR, canActAsDriver: true })),
    ).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: API_ERROR_CODES.PERMISSION_DENIED });
  });

  it("a DRIVER-role user is never permission-checked", () => {
    mode = "live";
    held = [];
    expect(
      guard.canActivate(ctxFor("shared", { sub: "d", tenantId: "t1", role: UserRole.DRIVER })),
    ).toBe(true);
    expect(effective).not.toHaveBeenCalled();
  });

  it("the role check still comes first: an operator on an admin-only handler is false, with no lookup", () => {
    expect(guard.canActivate(ctxFor("admin", OPERATOR))).toBe(false);
    expect(effective).not.toHaveBeenCalled();
  });

  it("constructed without the service (every older spec) the guard behaves exactly as before", () => {
    const bare = new RolesGuard(new Reflector());
    expect(bare.canActivate(ctxFor("orders", OPERATOR))).toBe(true);
  });

  describe("class-level metadata with method overrides", () => {
    const ctx = (m: keyof GroupedCtl) =>
      ({
        getHandler: () => GroupedCtl.prototype[m],
        getClass: () => GroupedCtl,
        switchToHttp: () => ({ getRequest: () => ({ user: OPERATOR }) }),
      }) as unknown as ExecutionContext;

    beforeEach(() => {
      mode = "live";
      held = ["ORDERS"];
    });

    it("a handler inherits the class group (FINANCE denied here)", async () => {
      const err: any = await Promise.resolve(guard.canActivate(ctx("inherits"))).catch((e) => e);
      expect(err.getResponse().groups).toEqual(["FINANCE"]);
    });

    it("PermissionBase on the method overrides the class group: any operator", () => {
      expect(guard.canActivate(ctx("baseOverride"))).toBe(true);
    });

    it("a method group overrides the class group", async () => {
      await expect(guard.canActivate(ctx("groupOverride"))).resolves.toBe(true);
    });
  });
});
