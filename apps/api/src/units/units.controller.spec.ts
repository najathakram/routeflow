import { RequestMethod } from "@nestjs/common";
import { METHOD_METADATA, PATH_METADATA } from "@nestjs/common/constants";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { UnitsController } from "./units.controller";

const proto = UnitsController.prototype as unknown as Record<string, object>;
const handlers = () => Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
const methodOf = (h: string) => Reflect.getMetadata(METHOD_METADATA, proto[h]) as RequestMethod;
const rolesOf = (h: string) => Reflect.getMetadata(ROLES_KEY, proto[h]) as UserRole[] | undefined;

describe("UnitsController", () => {
  it("is mounted at /units behind JwtAuthGuard AND RolesGuard", () => {
    expect(Reflect.getMetadata(PATH_METADATA, UnitsController)).toBe("units");
    const guards = (Reflect.getMetadata("__guards__", UnitsController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  it("serves exactly GET, POST and PATCH, and has NO DELETE route (archive, never delete)", () => {
    const methods = handlers().map(methodOf);
    expect(methods.sort()).toEqual(
      [RequestMethod.GET, RequestMethod.PATCH, RequestMethod.POST].sort(),
    );
    expect(methods).not.toContain(RequestMethod.DELETE);
  });

  it("every handler is OPERATOR (covers TENANT_ADMIN), none is unguarded", () => {
    expect(handlers()).toHaveLength(3);
    for (const h of handlers()) expect(rolesOf(h)).toEqual([UserRole.OPERATOR]);
  });

  it("is not behind any plan flag or add-on gate", () => {
    for (const h of handlers()) {
      const keys = Reflect.getMetadataKeys(proto[h]).map(String);
      expect(keys.filter((k) => /plan.?flag|addon/i.test(k))).toEqual([]);
    }
    const classKeys = Reflect.getMetadataKeys(UnitsController).map(String);
    expect(classKeys.filter((k) => /plan.?flag|addon/i.test(k))).toEqual([]);
  });

  describe("RolesGuard against the handlers", () => {
    const guard = new RolesGuard(new Reflector());
    const ctx = (h: string, role: UserRole) =>
      ({
        getHandler: () => proto[h],
        getClass: () => UnitsController,
        switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
      }) as never;

    it.each(["list", "create", "update"])(
      "%s: operator and tenant admin pass; driver and buyer are refused",
      (h) => {
        expect(guard.canActivate(ctx(h, UserRole.OPERATOR))).toBe(true);
        expect(guard.canActivate(ctx(h, UserRole.TENANT_ADMIN))).toBe(true);
        expect(guard.canActivate(ctx(h, UserRole.DRIVER))).toBe(false);
        expect(guard.canActivate(ctx(h, UserRole.CUSTOMER))).toBe(false);
      },
    );
  });
});
