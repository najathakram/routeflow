import { ExecutionContext } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { readFileSync } from "fs";
import { join } from "path";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { RolesGuard } from "../auth/guards/roles.guard";
import { RuleTargetsController } from "./rule-targets.controller";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";

/**
 * Row 509 PR2: the rule-targets routes are OPERATOR (TENANT_ADMIN satisfies it) behind both guards, CUSTOMER / DRIVER /
 * buyer tokens are refused, and the controller is registered BEFORE the admin controller so nothing there can shadow
 * `GET :id` or `POST holding`. (The all-customer-rule 403 is the service's `assertMayManageRule`; pinned in the DB spec.)
 */
const proto = RuleTargetsController.prototype as unknown as Record<string, object>;
const HANDLERS = ["holding", "detail", "add", "remove"] as const;

describe("RuleTargetsController", () => {
  it.each(HANDLERS)("%s is OPERATOR and the class is behind both guards", (handler) => {
    expect(Reflect.getMetadata(ROLES_KEY, proto[handler])).toEqual([UserRole.OPERATOR]);
    const guards = (Reflect.getMetadata("__guards__", RuleTargetsController) ?? []).map(
      (g: { name: string }) => g.name,
    );
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });

  const guard = new RolesGuard(new Reflector());
  const can = (user: Record<string, unknown>, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => RuleTargetsController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);

  it.each(HANDLERS)(
    "%s: OPERATOR and TENANT_ADMIN pass; CUSTOMER, DRIVER and buyers get 403",
    (handler) => {
      expect(can({ role: UserRole.OPERATOR }, handler)).toBe(true);
      expect(can({ role: UserRole.TENANT_ADMIN }, handler)).toBe(true);
      expect(can({ role: UserRole.CUSTOMER }, handler)).toBe(false);
      expect(can({ role: UserRole.DRIVER }, handler)).toBe(false);
      expect(can({ role: UserRole.DRIVER, canActAsDriver: true }, handler)).toBe(false);
      expect(can({ type: "BUYER" }, handler)).toBe(false);
    },
  );

  it("the routes are the contract's: GET :id, POST :id/targets, POST :id/targets/remove, POST holding", () => {
    const route = (h: string) => [
      Reflect.getMetadata("method", proto[h]),
      Reflect.getMetadata("path", proto[h]),
    ];
    // RequestMethod: GET = 0, POST = 1
    expect(route("detail")).toEqual([0, ":id"]);
    expect(route("add")).toEqual([1, ":id/targets"]);
    expect(route("remove")).toEqual([1, ":id/targets/remove"]);
    expect(route("holding")).toEqual([1, "holding"]);
  });
});

describe("SellingRestrictionsAdminModule controller order", () => {
  const src = readFileSync(join(__dirname, "selling-restrictions-admin.module.ts"), "utf8");
  const block = src.slice(
    src.indexOf("controllers: ["),
    src.indexOf("]", src.indexOf("controllers: [")),
  );

  it("RuleTargetsController is registered before SellingRestrictionsAdminController", () => {
    expect(block.indexOf("RuleTargetsController")).toBeGreaterThanOrEqual(0);
    expect(block.indexOf("RuleTargetsController")).toBeLessThan(
      block.indexOf("SellingRestrictionsAdminController"),
    );
  });

  it("the admin controller declares no single-segment :id route a target route could collide with", () => {
    const adminProto = SellingRestrictionsAdminController.prototype as unknown as Record<
      string,
      object
    >;
    const paths = Object.getOwnPropertyNames(adminProto)
      .filter((n) => n !== "constructor")
      .map((n) => Reflect.getMetadata("path", adminProto[n]));
    expect(paths).not.toContain(":id");
    expect(paths).not.toContain("holding");
  });
});
