import "reflect-metadata";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RuleEditController } from "./rule-edit.controller";

const roles = (method: keyof RuleEditController) =>
  Reflect.getMetadata(ROLES_KEY, RuleEditController.prototype[method]) as UserRole[];

describe("RuleEditController", () => {
  it("is mounted under /selling-restrictions and guarded by JWT + roles", () => {
    expect(Reflect.getMetadata("path", RuleEditController)).toBe("selling-restrictions");
    const guards = Reflect.getMetadata("__guards__", RuleEditController) as Array<{ name: string }>;
    expect(guards.map((g) => g.name)).toEqual(["JwtAuthGuard", "RolesGuard"]);
  });

  it("preview and commit are OPERATOR (TENANT_ADMIN satisfies it; CUSTOMER / DRIVER are refused)", () => {
    expect(roles("preview")).toEqual([UserRole.OPERATOR]);
    expect(roles("commit")).toEqual([UserRole.OPERATOR]);
  });

  it("routes: POST :id/edit-preview and PUT :id", () => {
    const route = (m: keyof RuleEditController) => [
      Reflect.getMetadata("path", RuleEditController.prototype[m]),
      Reflect.getMetadata("method", RuleEditController.prototype[m]),
    ];
    expect(route("preview")).toEqual([":id/edit-preview", 1]); // RequestMethod.POST
    expect(route("commit")).toEqual([":id", 2]); // RequestMethod.PUT
  });
});
