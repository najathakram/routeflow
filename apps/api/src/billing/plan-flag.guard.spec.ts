import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PlanFlagGuard } from "./plan-flag.guard";
import { EntitlementsService } from "./entitlements.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { PlanGateErrorBody } from "./plan-gate";

function contextFor(user: { tenantId: string | null } | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

const NO_UPGRADE = {
  planKey: null,
  planMonthlyPrice: null,
  addonSku: null,
  addonMonthlyPrice: null,
};

describe("PlanFlagGuard", () => {
  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { hasFlag: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
    );
  });

  it("allows requests with no @RequirePlanFlag metadata", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.hasFlag).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN (null tenantId) through any plan gate", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    await expect(guard.canActivate(contextFor({ tenantId: null }))).resolves.toBe(true);
    expect(entitlements.hasFlag).not.toHaveBeenCalled();
  });

  it("allows tenants whose plan grants the flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.hasFlag.mockResolvedValue(true);
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.hasFlag).toHaveBeenCalledWith("t1", "flag.reports");
  });

  it("throws a LOCKED_PAGE PLAN_GATE when only a plan upgrade grants the flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.hasFlag.mockResolvedValue(false);
    catalog.upgradeTargetForFlag.mockResolvedValue({
      planKey: "TEAM",
      planMonthlyPrice: "149.00",
      addonSku: null,
      addonMonthlyPrice: null,
    });
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as PlanGateErrorBody;
    expect(body.code).toBe("PLAN_GATE");
    expect(body.state).toBe("LOCKED_PAGE");
    expect(body.flag).toBe("flag.reports");
    expect(body.upgrade.planKey).toBe("TEAM");
  });

  it("throws an INLINE_RESOLVE PLAN_GATE when an add-on grants the flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("addon.buyer_portal");
    entitlements.hasFlag.mockResolvedValue(false);
    catalog.upgradeTargetForFlag.mockResolvedValue({
      planKey: "BUSINESS",
      planMonthlyPrice: "349.00",
      addonSku: "BUYER_PORTAL",
      addonMonthlyPrice: "49.00",
    });
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    const body = err.getResponse() as PlanGateErrorBody;
    expect(body.state).toBe("INLINE_RESOLVE");
    expect(body.upgrade.addonSku).toBe("BUYER_PORTAL");
  });

  it("reads tenantId from req.user; a request without a user passes (JwtAuthGuard owns that)", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);
  });

  it("fails CLOSED with a distinguishable error when entitlement resolution throws", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.hasFlag.mockRejectedValue(new Error("db down"));
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("PLAN_GATE_UNAVAILABLE");
  });
});
