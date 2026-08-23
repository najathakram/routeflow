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
  // These tests exercise the flag-gating logic itself, which sits behind the
  // PLAN_FLAG_ENFORCEMENT kill switch (see the describe block below) — turn it
  // on here so canActivate reaches that logic instead of short-circuiting true.
  const ORIGINAL_ENV = process.env;

  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PLAN_FLAG_ENFORCEMENT: "on" };
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { hasFlag: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
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

describe("PLAN_FLAG_ENFORCEMENT kill switch", () => {
  const ORIGINAL_ENV = process.env;

  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { hasFlag: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { hasFlag: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("enforces the gate when PLAN_FLAG_ENFORCEMENT=on and the tenant has the flag", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.hasFlag.mockResolvedValue(true);
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.hasFlag).toHaveBeenCalledWith("t1", "flag.reports");
  });

  it("throws a PLAN_GATE 403 when PLAN_FLAG_ENFORCEMENT=on and the flag is absent", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.hasFlag.mockResolvedValue(false);
    catalog.upgradeTargetForFlag.mockResolvedValue({
      planKey: "SCALE",
      planMonthlyPrice: "499.00",
      addonSku: null,
      addonMonthlyPrice: null,
    });
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as PlanGateErrorBody;
    expect(body.code).toBe("PLAN_GATE");
    expect(body.flag).toBe("flag.reports");
    expect(body.upgrade.planKey).toBe("SCALE");
  });

  it.each([
    ["unset", undefined],
    ["off", "off"],
    ["any other value", "banana"],
  ])(
    "allows the newly added gates without consulting entitlements when PLAN_FLAG_ENFORCEMENT is %s",
    async (_label, value) => {
      if (value === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = value;
      reflector.getAllAndOverride.mockReturnValue("flag.reports");
      // Even a mock configured to deny must never be consulted — the switch short-circuits first.
      entitlements.hasFlag.mockResolvedValue(false);
      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
      expect(entitlements.hasFlag).not.toHaveBeenCalled();
    },
  );

  // REGRESSION: the switch must only mute the gates this rollout adds. flag.msrp
  // (POST /products/msrp/bulk, shipped in #411) was enforcing before the switch
  // existed and has no service-level backstop — muting it would silently reopen it.
  it.each([
    ["unset", undefined],
    ["off", "off"],
  ])(
    "still enforces the pre-existing flag.msrp gate when PLAN_FLAG_ENFORCEMENT is %s",
    async (_label, value) => {
      if (value === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = value;
      reflector.getAllAndOverride.mockReturnValue("flag.msrp");
      entitlements.hasFlag.mockResolvedValue(false);
      const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as PlanGateErrorBody).flag).toBe("flag.msrp");
      expect(entitlements.hasFlag).toHaveBeenCalledWith("t1", "flag.msrp");
    },
  );

  // All flags gated by @RequirePlanFlag in this plan (WP2); a SCALE tenant carries every
  // v8 flag, so it must clear each one once enforcement is switched on.
  const SCALE_PLAN_FLAGS = [
    "flag.analytics",
    "flag.ap_bills",
    "flag.import_integrations",
    "flag.forecasting",
    "flag.pricing_tiers",
    "flag.reports",
    "flag.returns",
  ];

  it.each(SCALE_PLAN_FLAGS)(
    "a SCALE entitlement set passes the %s gate when enforcement is on",
    async (flagKey) => {
      process.env.PLAN_FLAG_ENFORCEMENT = "on";
      reflector.getAllAndOverride.mockReturnValue(flagKey);
      entitlements.hasFlag.mockImplementation(async (_tenantId: string, key: string) =>
        SCALE_PLAN_FLAGS.includes(key),
      );
      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    },
  );
});
