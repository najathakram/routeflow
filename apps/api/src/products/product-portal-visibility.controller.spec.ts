import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { plainToInstance } from "class-transformer";
import { validate } from "class-validator";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import { ProductPortalVisibilityController } from "./product-portal-visibility.controller";
import { BulkSetPortalVisibilityDto, SetPortalVisibilityDto } from "./dto/portal-visibility.dto";
import { ListProductsDto } from "./dto/list-products.dto";

const proto = ProductPortalVisibilityController.prototype as unknown as Record<string, () => void>;
const guard = new RolesGuard(new Reflector());
const ctxFor = (handler: string, role: UserRole) =>
  ({
    getHandler: () => proto[handler],
    getClass: () => ProductPortalVisibilityController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  }) as unknown as ExecutionContext;

describe("ProductPortalVisibilityController role gate (RolesGuard => 403 when false)", () => {
  it("is behind JwtAuthGuard and RolesGuard", () => {
    const names = (Reflect.getMetadata("__guards__", ProductPortalVisibilityController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(names).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  it.each(["setOne", "setBulk"])("%s admits TENANT_ADMIN only", (h) => {
    expect(guard.canActivate(ctxFor(h, UserRole.TENANT_ADMIN))).toBe(true);
    expect(guard.canActivate(ctxFor(h, UserRole.OPERATOR))).toBe(false);
    expect(guard.canActivate(ctxFor(h, UserRole.DRIVER))).toBe(false);
    expect(guard.canActivate(ctxFor(h, UserRole.CUSTOMER))).toBe(false);
  });

  it("routes: bulk PATCH portal-visibility, single PATCH :id/portal-visibility", () => {
    expect(Reflect.getMetadata("path", proto.setBulk)).toBe("portal-visibility");
    expect(Reflect.getMetadata("path", proto.setOne)).toBe(":id/portal-visibility");
  });
});

describe("portal-visibility DTO validation", () => {
  const bulk = (o: object) => validate(plainToInstance(BulkSetPortalVisibilityDto, o));
  const bad = async (o: object) => (await bulk(o)).length > 0;

  it("accepts 1..200 unique string ids and a boolean", async () => {
    expect(await bad({ ids: ["a"], portalVisible: false })).toBe(false);
    const ids = Array.from({ length: 200 }, (_, i) => `p${i}`);
    expect(await bad({ ids, portalVisible: true })).toBe(false);
  });
  it("rejects empty, 201, duplicate ids and non-string ids", async () => {
    expect(await bad({ ids: [], portalVisible: true })).toBe(true);
    const ids = Array.from({ length: 201 }, (_, i) => `p${i}`);
    expect(await bad({ ids, portalVisible: true })).toBe(true);
    expect(await bad({ ids: ["a", "a"], portalVisible: true })).toBe(true);
    expect(await bad({ ids: [1], portalVisible: true })).toBe(true);
  });
  it("rejects a non-boolean portalVisible (single and bulk) and a missing one", async () => {
    expect(await bad({ ids: ["a"], portalVisible: "true" })).toBe(true);
    expect(await bad({ ids: ["a"] })).toBe(true);
    const single = (o: object) => validate(plainToInstance(SetPortalVisibilityDto, o));
    expect(await single({ portalVisible: 1 })).not.toHaveLength(0);
    expect(await single({})).not.toHaveLength(0);
    expect(await single({ portalVisible: false })).toHaveLength(0);
  });
});

describe("ListProductsDto.portalVisible", () => {
  it("parses 'false'/'true' to booleans and leaves absent undefined", async () => {
    const f = plainToInstance(ListProductsDto, { portalVisible: "false" });
    expect(f.portalVisible).toBe(false);
    expect(plainToInstance(ListProductsDto, { portalVisible: "true" }).portalVisible).toBe(true);
    expect(plainToInstance(ListProductsDto, {}).portalVisible).toBeUndefined();
    expect(await validate(f)).toHaveLength(0);
  });
});
