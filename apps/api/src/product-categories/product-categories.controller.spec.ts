import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { ProductCategoriesController } from "./product-categories.controller";

// Labels decide what a selling ban covers, so every WRITE is TENANT_ADMIN-only (owner ruling,
// Lane R) — pinned per handler so a new route cannot quietly land at OPERATOR.
const proto = ProductCategoriesController.prototype as unknown as Record<string, unknown>;
const rolesOf = (handler: string) =>
  Reflect.getMetadata(ROLES_KEY, proto[handler] as object) as UserRole[] | undefined;

describe("ProductCategoriesController role gates", () => {
  it("the class is behind JwtAuthGuard AND RolesGuard (role metadata alone enforces nothing)", () => {
    const guards = (Reflect.getMetadata("__guards__", ProductCategoriesController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  it.each(["create", "update", "setLabel", "removeLabel"])("%s is TENANT_ADMIN only", (h) => {
    expect(rolesOf(h)).toEqual([UserRole.TENANT_ADMIN]);
  });

  it.each(["list", "getLabels"])("%s is readable by OPERATOR", (h) => {
    expect(rolesOf(h)).toEqual([UserRole.OPERATOR]);
  });

  it("every route handler declares a role (none falls through unguarded)", () => {
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    for (const h of handlers) expect(rolesOf(h)).toBeDefined();
  });
});
