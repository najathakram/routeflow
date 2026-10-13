import { OperatorPermissionGroup, UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { TenantContextService } from "../../tenant/tenant-context.service";
import { createMockPrisma } from "../../testing/prisma-mock";
import {
  ALL_PERMISSION_GROUPS,
  OperatorPermissionsService,
  PERMISSIONS_MODE,
  groupsFromDenied,
} from "./operator-permissions.service";
import {
  permissionDeniedException,
  permissionsVersionConflictException,
} from "./permission-errors";

const ALL = Object.values(OperatorPermissionGroup);

describe("groupsFromDenied", () => {
  it("an empty, null or undefined deny list means every group", () => {
    expect(groupsFromDenied([])).toEqual(ALL);
    expect(groupsFromDenied(null)).toEqual(ALL);
    expect(groupsFromDenied(undefined)).toEqual(ALL);
    expect(ALL).toHaveLength(9);
  });

  it("removes exactly the denied groups and keeps the display order", () => {
    expect(groupsFromDenied(["FINANCE", "ORDERS"])).toEqual([
      "DISPATCH",
      "CUSTOMERS",
      "CATALOG",
      "PRICING",
      "REGULATED",
      "NOTIFICATIONS",
      "REPORTS",
    ]);
  });

  it("denying every group leaves none", () => {
    expect(groupsFromDenied(ALL)).toEqual([]);
  });

  it("ignores a duplicate and an unknown value in the deny list", () => {
    expect(groupsFromDenied(["ORDERS", "ORDERS"]).length).toBe(8);
    expect(groupsFromDenied(["NOT_A_GROUP" as OperatorPermissionGroup])).toEqual(ALL);
  });

  it("does not mutate its input and returns a fresh array", () => {
    const denied: OperatorPermissionGroup[] = ["PRICING"];
    const out = groupsFromDenied(denied);
    expect(denied).toEqual(["PRICING"]);
    out.pop();
    expect(groupsFromDenied(denied)).toHaveLength(8);
    expect(ALL_PERMISSION_GROUPS).toHaveLength(9);
  });
});

describe("OperatorPermissionsService.effective", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: OperatorPermissionsService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new OperatorPermissionsService(prisma as any);
  });

  it.each([UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN])(
    "%s holds every group at version 0 with no database read",
    async (role) => {
      const out = await service.effective({ sub: "u1", tenantId: "t1", role });
      expect(out).toEqual({ groups: ALL, version: 0 });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(prisma.forTenant).not.toHaveBeenCalled();
    },
  );

  it("an admin's groups are a copy: mutating them never changes the shared list", async () => {
    const a = await service.effective({ sub: "u1", tenantId: "t1", role: UserRole.TENANT_ADMIN });
    a.groups.length = 0;
    expect(ALL_PERMISSION_GROUPS).toHaveLength(9);
  });

  it("an operator with an empty deny list holds every group and reports the stored version", async () => {
    prisma.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 3 });
    const out = await service.effective({ sub: "op1", tenantId: "t1", role: UserRole.OPERATOR });
    expect(out).toEqual({ groups: ALL, version: 3 });
  });

  it("an operator holds every group minus the denied ones", async () => {
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: ["PRICING", "FINANCE"],
      permissionsVersion: 7,
    });
    const out = await service.effective({ sub: "op1", tenantId: "t1", role: UserRole.OPERATOR });
    expect(out.version).toBe(7);
    expect(out.groups).toEqual(ALL.filter((g) => g !== "PRICING" && g !== "FINANCE"));
  });

  it("an operator whose row is missing (deleted, or another tenant's id) holds no groups", async () => {
    prisma.user.findFirst.mockResolvedValue(null);
    const out = await service.effective({ sub: "ghost", tenantId: "t1", role: UserRole.OPERATOR });
    expect(out).toEqual({ groups: [], version: 0 });
  });

  it("reads the row on the BASE client, scoped by id + tenantId + not-deleted, selecting only the two columns", async () => {
    prisma.user.findFirst.mockResolvedValue({ deniedPermissionGroups: [], permissionsVersion: 0 });
    await service.effective({ sub: "op1", tenantId: "t9", role: UserRole.OPERATOR });
    expect(prisma.user.findFirst).toHaveBeenCalledTimes(1);
    expect(prisma.user.findFirst).toHaveBeenCalledWith({
      where: { id: "op1", tenantId: "t9", deletedAt: null },
      select: { deniedPermissionGroups: true, permissionsVersion: true },
    });
    // The tenant-scoped client shares its model mocks with the base client, so assert it was never asked for.
    expect(prisma.forTenant).not.toHaveBeenCalled();
  });

  it("does not rely on the tenant context: it runs, with the tenantId from the principal, when no tenant ALS store is set", async () => {
    const ctx = new TenantContextService();
    expect(ctx.getOrNull()).toBeNull(); // nothing initialised on this async chain
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: ["REPORTS"],
      permissionsVersion: 1,
    });
    const out = await service.effective({ sub: "op1", tenantId: "t1", role: UserRole.OPERATOR });
    expect(out.groups).not.toContain("REPORTS");
    const call = prisma.user.findFirst.mock.calls[0][0] as { where: { tenantId: string } };
    expect(call.where.tenantId).toBe("t1");
  });

  it("an operator token with no tenant holds no groups and reads nothing", async () => {
    const out = await service.effective({ sub: "op1", tenantId: null, role: UserRole.OPERATOR });
    expect(out).toEqual({ groups: [], version: 0 });
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it.each([UserRole.DRIVER, UserRole.CUSTOMER])(
    "%s holds no groups and reads nothing",
    async (role) => {
      const out = await service.effective({ sub: "u1", tenantId: "t1", role });
      expect(out).toEqual({ groups: [], version: 0 });
      expect(prisma.user.findFirst).not.toHaveBeenCalled();
    },
  );

  it("an unknown role holds no groups", async () => {
    const out = await service.effective({
      sub: "u1",
      tenantId: "t1",
      role: "AGENT" as unknown as UserRole,
    });
    expect(out).toEqual({ groups: [], version: 0 });
  });
});

describe("OperatorPermissionsService.mine (the /me payload)", () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let service: OperatorPermissionsService;

  beforeEach(() => {
    prisma = createMockPrisma();
    service = new OperatorPermissionsService(prisma as any);
  });

  it("always reports shadow mode in this release", async () => {
    expect(PERMISSIONS_MODE).toBe("shadow");
    const out = await service.mine({ sub: "u1", tenantId: "t1", role: UserRole.TENANT_ADMIN });
    expect(out.mode).toBe("shadow");
  });

  it("account admin: every group, isAccountAdmin true, version 0", async () => {
    const out = await service.mine({ sub: "u1", tenantId: "t1", role: UserRole.TENANT_ADMIN });
    expect(out).toEqual({
      role: "TENANT_ADMIN",
      isAccountAdmin: true,
      groups: ALL,
      version: 0,
      mode: "shadow",
    });
  });

  it("operator: groups from the row, isAccountAdmin false", async () => {
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: ["DISPATCH"],
      permissionsVersion: 2,
    });
    const out = await service.mine({ sub: "op1", tenantId: "t1", role: UserRole.OPERATOR });
    expect(out.isAccountAdmin).toBe(false);
    expect(out.version).toBe(2);
    expect(out.groups).toEqual(ALL.filter((g) => g !== "DISPATCH"));
  });

  it("driver: no groups, isAccountAdmin false", async () => {
    const out = await service.mine({ sub: "d1", tenantId: "t1", role: UserRole.DRIVER });
    expect(out).toEqual({
      role: "DRIVER",
      isAccountAdmin: false,
      groups: [],
      version: 0,
      mode: "shadow",
    });
  });
});

describe("permission error helpers", () => {
  it("permissionDeniedException is a 403 carrying the code and the groups that would have opened it", () => {
    const err = permissionDeniedException(["FINANCE", "ORDERS"]);
    expect(err.getStatus()).toBe(403);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.PERMISSION_DENIED,
      groups: ["FINANCE", "ORDERS"],
    });
  });

  it("permissionsVersionConflictException is a 409 carrying the code and the current version", () => {
    const err = permissionsVersionConflictException(5);
    expect(err.getStatus()).toBe(409);
    expect(err.getResponse()).toMatchObject({
      code: API_ERROR_CODES.PERMISSIONS_VERSION_CONFLICT,
      version: 5,
    });
  });
});
