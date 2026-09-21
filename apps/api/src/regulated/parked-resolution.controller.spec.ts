/** Who may resolve a parked reversal, and what the request body may carry. */
import { BadRequestException, ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { RegulatedController } from "./regulated.controller";
import { RolesGuard } from "../auth/guards/roles.guard";
import { REQUIRE_ADDON_KEY } from "../billing/require-addon.decorator";
import { ResolveParkedDto } from "./dto/resolve-parked.dto";

const ctx = (handler: (...a: any[]) => any, role: UserRole | undefined): ExecutionContext =>
  ({
    getHandler: () => handler,
    getClass: () => RegulatedController,
    switchToHttp: () => ({ getRequest: () => ({ user: role ? { role } : undefined }) }),
  }) as unknown as ExecutionContext;

describe("resolving a parked reversal: roles", () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);
  const handler = RegulatedController.prototype.resolveParked;

  it("mirrors prepareFiling: OPERATOR and TENANT_ADMIN (and SUPER_ADMIN) pass", () => {
    for (const role of [UserRole.OPERATOR, UserRole.TENANT_ADMIN, UserRole.SUPER_ADMIN]) {
      expect(guard.canActivate(ctx(handler, role))).toBe(true);
    }
  });

  it("a DRIVER, a CUSTOMER and an unauthenticated request are refused (a false guard is a 403)", () => {
    for (const role of [UserRole.DRIVER, UserRole.CUSTOMER, undefined]) {
      expect(guard.canActivate(ctx(handler, role))).toBe(false);
    }
  });

  it("resolve and list carry the SAME role and addon rules as filings/prepare", () => {
    const proto = RegulatedController.prototype;
    const rolesOf = (h: any) => reflector.getAllAndOverride("roles", [h, RegulatedController]);
    expect(rolesOf(proto.resolveParked)).toEqual(rolesOf(proto.prepare));
    expect(rolesOf(proto.listParked)).toEqual(rolesOf(proto.prepare));
    const addonOf = (h: any) => reflector.get(REQUIRE_ADDON_KEY, h);
    expect(addonOf(proto.prepare)).toEqual(["tobacco_dealer"]);
    expect(addonOf(proto.resolveParked)).toEqual(addonOf(proto.prepare));
    expect(addonOf(proto.listParked)).toEqual(addonOf(proto.prepare));
  });
});

describe("resolving a parked reversal: the body is the PACK only", () => {
  const pipe = new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true });
  const run = (body: unknown) => pipe.transform(body, { type: "body", metatype: ResolveParkedDto });

  it("accepts an integer pack from 2 to 10000", async () => {
    await expect(run({ unitsPerBoxSupplied: 12 })).resolves.toMatchObject({
      unitsPerBoxSupplied: 12,
    });
    await expect(run({ unitsPerBoxSupplied: 2 })).resolves.toBeDefined();
    await expect(run({ unitsPerBoxSupplied: 10000 })).resolves.toBeDefined();
  });

  it("rejects 1, 0, negatives, fractions, garbage, oversize and a missing pack with a 400", async () => {
    for (const bad of [1, 0, -12, 1.5, "abc", null, 10001, undefined]) {
      await expect(run({ unitsPerBoxSupplied: bad })).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(run({})).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects a retyped quantity: the pieces come from the stored row, never the request", async () => {
    for (const extra of ["returnedPieces", "qty", "pieces", "returnedQty", "unitsPerBox"]) {
      await expect(run({ unitsPerBoxSupplied: 12, [extra]: 99 })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    }
  });
});
