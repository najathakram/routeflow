import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { ProductCategoriesController } from "./product-categories.controller";

// Category create/edit stays TENANT_ADMIN-only (owner ruling, Lane R). Product label add/remove is open to
// OPERATOR (owner ruling 2026-10-14); a label an active federal rule covers stays admin-only in the service.
// Pinned per handler so a route cannot quietly change level.
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

  it.each(["create", "update"])("%s is TENANT_ADMIN only", (h) => {
    expect(rolesOf(h)).toEqual([UserRole.TENANT_ADMIN]);
  });

  it.each(["list", "getLabels", "setLabel", "removeLabel"])("%s is open to OPERATOR", (h) => {
    expect(rolesOf(h)).toEqual([UserRole.OPERATOR]);
  });

  it("every route handler declares a role (none falls through unguarded)", () => {
    const handlers = Object.getOwnPropertyNames(proto).filter((n) => n !== "constructor");
    for (const h of handlers) expect(rolesOf(h)).toBeDefined();
  });
});
