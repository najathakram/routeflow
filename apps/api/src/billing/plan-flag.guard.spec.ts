import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { PlanFlagGuard } from "./plan-flag.guard";
import { EntitlementsService } from "./entitlements.service";
import { PlanCatalogService } from "./plan-catalog.service";
import { FeatureOverrideService } from "./feature-override.service";
import { PlanGateErrorBody } from "./plan-gate";
import { EntitlementAuthority } from "./entitlement-authority.service";
import { FeatureResolverService } from "./feature-resolver.service";
import { EntitlementsModeService } from "./entitlements-mode.service";
import { FeatureDiffService } from "./feature-diff.service";

/**
 * Feature grants v2 brief A: PlanFlagGuard's decision now lives in
 * EntitlementAuthority.can() (see plan-flag.guard.ts's header comment). Every test in this file
 * pre-dates that refactor and asserts on the OLD-PATH decision specifically — mocking the
 * resolver to return `null` (as if unavailable) makes `can()` degrade to exactly that old-path
 * computation (see entitlement-authority.service.ts's `if (resolved === null) return
 * oldVerdict;`), so these fixtures keep meaning what they always meant without knowing
 * anything about the resolver/diff-log machinery this brief adds.
 */
function buildAuthority(
  entitlements: { resolve: jest.Mock },
  featureOverrides: { get: jest.Mock },
): EntitlementAuthority {
  const prisma = { tenantAddon: { findUnique: jest.fn().mockResolvedValue(null) } } as any;
  const resolver = {
    resolve: jest.fn().mockResolvedValue(null),
  } as unknown as FeatureResolverService;
  const modeService = {
    getMode: jest.fn().mockResolvedValue("shadow"),
  } as unknown as EntitlementsModeService;
  const diffService = { record: jest.fn() } as unknown as FeatureDiffService;
  return new EntitlementAuthority(
    entitlements as unknown as EntitlementsService,
    featureOverrides as unknown as FeatureOverrideService,
    resolver,
    modeService,
    diffService,
    prisma,
  );
}

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
  // WP2 collaborator-contract change: the guard now calls entitlements.resolve(tenantId)
  // (it needs the full entitlement snapshot — planKey included — to run the dark-flag
  // policy in plan-flag-policy.ts's allowsFlag()), not entitlements.hasFlag(tenantId, key).
  // This is a fixture-shape change only; every pre-existing behavioral assertion below is
  // preserved by feeding `resolve` an equivalent { planKey, flags } snapshot.
  let entitlements: { resolve: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };
  let featureOverrides: { get: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PLAN_FLAG_ENFORCEMENT: "on" };
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { resolve: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    // Every pre-existing test in this file exercises a tenant with no override rows, so this
    // collaborator-contract addition (feature-grants PR-1) defaults to "no override" — the
    // same plan+dark behavior those tests already assert on.
    featureOverrides = { get: jest.fn().mockResolvedValue(null) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
      featureOverrides as unknown as FeatureOverrideService,
      buildAuthority(entitlements, featureOverrides),
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("allows requests with no @RequirePlanFlag metadata", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.resolve).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN (null tenantId) through any plan gate", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    await expect(guard.canActivate(contextFor({ tenantId: null }))).resolves.toBe(true);
    expect(entitlements.resolve).not.toHaveBeenCalled();
  });

  it("allows tenants whose plan grants the flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "SCALE", flags: ["flag.reports"] });
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.resolve).toHaveBeenCalledWith("t1");
  });

  it("throws a LOCKED_PAGE PLAN_GATE when only a plan upgrade grants the flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
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
    entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
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
    entitlements.resolve.mockRejectedValue(new Error("db down"));
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("PLAN_GATE_UNAVAILABLE");
  });
});

describe("PLAN_FLAG_ENFORCEMENT kill switch", () => {
  const ORIGINAL_ENV = process.env;

  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { resolve: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };
  let featureOverrides: { get: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { resolve: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    // Every pre-existing test in this file exercises a tenant with no override rows, so this
    // collaborator-contract addition (feature-grants PR-1) defaults to "no override" — the
    // same plan+dark behavior those tests already assert on.
    featureOverrides = { get: jest.fn().mockResolvedValue(null) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
      featureOverrides as unknown as FeatureOverrideService,
      buildAuthority(entitlements, featureOverrides),
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("enforces the gate when PLAN_FLAG_ENFORCEMENT=on and the tenant has the flag", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "SCALE", flags: ["flag.reports"] });
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.resolve).toHaveBeenCalledWith("t1");
  });

  it("throws a PLAN_GATE 403 when PLAN_FLAG_ENFORCEMENT=on and the flag is absent", async () => {
    process.env.PLAN_FLAG_ENFORCEMENT = "on";
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
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
    // WP2/R3a.7 note (brief/test conflict, flagged in the WP2 report): before WP2, this test's
    // title read "...without consulting entitlements..." and asserted entitlements.hasFlag was
    // NEVER called. The WP2 brief's canActivate now ALWAYS resolves the tenant's entitlements
    // (except for a null tenantId) so it can tell an always-enforced plan (LITE) apart from a
    // courtesy-dark one — see allowsFlag() in plan-flag-policy.ts. That "no consultation at all"
    // assertion is no longer true by design and could not be preserved verbatim; what the test
    // still proves — and what its non-Lite tenants actually rely on — is that the flag itself is
    // never the reason for a deny while the switch is off. See the WP2 R3a.7 describe block below
    // for the new LITE-tenant coverage this collaborator-contract change exists to enable.
    "allows the newly added gates for a non-always-enforced tenant when PLAN_FLAG_ENFORCEMENT is %s",
    async (_label, value) => {
      if (value === undefined) delete process.env.PLAN_FLAG_ENFORCEMENT;
      else process.env.PLAN_FLAG_ENFORCEMENT = value;
      reflector.getAllAndOverride.mockReturnValue("flag.reports");
      // Even a mock configured to withhold the flag itself must still pass — the courtesy
      // allow does not depend on the tenant actually carrying "flag.reports".
      entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
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
      entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
      const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err.getResponse() as PlanGateErrorBody).flag).toBe("flag.msrp");
      expect(entitlements.resolve).toHaveBeenCalledWith("t1");
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
      entitlements.resolve.mockResolvedValue({ planKey: "SCALE", flags: SCALE_PLAN_FLAGS });
      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    },
  );
});

// WP2 (R3a.1-R3a.7): the invite-only LITE plan is "always enforced" — it must never get the
// PLAN_FLAG_ENFORCEMENT kill switch's dark-flag courtesy allow, whether the switch is off or
// entitlement resolution itself fails.
describe("WP2 always-enforced plan (LITE) — no dark-flag courtesy allow", () => {
  const ORIGINAL_ENV = process.env;

  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { resolve: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };
  let featureOverrides: { get: jest.Mock };

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
    delete process.env.PLAN_FLAG_ENFORCEMENT; // dark flags stay dark for everyone else
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { resolve: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    // Every pre-existing test in this file exercises a tenant with no override rows, so this
    // collaborator-contract addition (feature-grants PR-1) defaults to "no override" — the
    // same plan+dark behavior those tests already assert on.
    featureOverrides = { get: jest.fn().mockResolvedValue(null) };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
      featureOverrides as unknown as FeatureOverrideService,
      buildAuthority(entitlements, featureOverrides),
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("R3a.7: denies a LITE tenant a dark flag it lacks, even though the kill switch is off", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports"); // a DARK_PLAN_FLAGS member
    entitlements.resolve.mockResolvedValue({ planKey: "LITE", flags: [] });
    catalog.upgradeTargetForFlag.mockResolvedValue({
      planKey: "STARTER",
      planMonthlyPrice: "49.00",
      addonSku: null,
      addonMonthlyPrice: null,
    });
    const err = await guard.canActivate(contextFor({ tenantId: "lite-1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as PlanGateErrorBody;
    expect(body.code).toBe("PLAN_GATE");
    expect(body.flag).toBe("flag.reports");
  });

  it("allows a LITE tenant that DOES carry the dark flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "LITE", flags: ["flag.reports"] });
    await expect(guard.canActivate(contextFor({ tenantId: "lite-1" }))).resolves.toBe(true);
  });

  it("a non-LITE tenant keeps the courtesy allow under the identical dark/off conditions (contrast case)", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
    await expect(guard.canActivate(contextFor({ tenantId: "starter-1" }))).resolves.toBe(true);
  });

  it("R3a.4: a dark flag still passes when entitlement resolution fails (courtesy allow survives a DB hiccup)", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    entitlements.resolve.mockRejectedValue(new Error("db down"));
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
  });

  it("a non-dark flag still fails CLOSED when entitlement resolution fails, even though R3a.4 covers dark flags", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.msrp"); // not in DARK_PLAN_FLAGS
    entitlements.resolve.mockRejectedValue(new Error("db down"));
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as { code: string }).code).toBe("PLAN_GATE_UNAVAILABLE");
  });

  it("R3a.5: SUPER_ADMIN (null tenantId) bypasses before any entitlement resolution, even for a dark flag", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    await expect(guard.canActivate(contextFor({ tenantId: null }))).resolves.toBe(true);
    expect(entitlements.resolve).not.toHaveBeenCalled();
  });
});

// Feature-grants PR-1 (owner ruling 2026-09-16): an active override is absolute — it decides
// before plan resolution, regardless of dark/enforced gate mode. Only its absence falls through
// to today's plan+dark behaviour (proven byte-identical by every test above, none of which
// configures featureOverrides.get beyond its "no override" default).
describe("feature-grants PR-1: override precedence (absolute, ignores plan and dark/enforced)", () => {
  const ORIGINAL_ENV = process.env;

  let guard: PlanFlagGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let entitlements: { resolve: jest.Mock };
  let catalog: { upgradeTargetForFlag: jest.Mock };
  let featureOverrides: { get: jest.Mock };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV, PLAN_FLAG_ENFORCEMENT: "on" };
    reflector = { getAllAndOverride: jest.fn() };
    entitlements = { resolve: jest.fn() };
    catalog = { upgradeTargetForFlag: jest.fn().mockResolvedValue(NO_UPGRADE) };
    featureOverrides = { get: jest.fn() };
    guard = new PlanFlagGuard(
      reflector as unknown as Reflector,
      entitlements as unknown as EntitlementsService,
      catalog as unknown as PlanCatalogService,
      featureOverrides as unknown as FeatureOverrideService,
      buildAuthority(entitlements, featureOverrides),
    );
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    warnSpy?.mockRestore();
  });

  it("row 6: GRANT wins even though the plan lacks the flag and the gate is enforced", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.msrp"); // not in DARK_PLAN_FLAGS
    featureOverrides.get.mockResolvedValue("GRANT");
    entitlements.resolve.mockResolvedValue({ planKey: "STARTER", flags: [] });
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.resolve).not.toHaveBeenCalled(); // GRANT short-circuits before plan resolution
  });

  it("row 5: GRANT wins on a dark flag too (uniform — dark/enforced is irrelevant once GRANT applies)", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.reports"); // a DARK_PLAN_FLAGS member
    featureOverrides.get.mockResolvedValue("GRANT");
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
  });

  it("row 4/8: DENY wins over a held flag on an enforced gate", async () => {
    reflector.getAllAndOverride.mockReturnValue("flag.msrp");
    featureOverrides.get.mockResolvedValue("DENY");
    entitlements.resolve.mockResolvedValue({ planKey: "ENTERPRISE", flags: ["flag.msrp"] });
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    const body = err.getResponse() as PlanGateErrorBody;
    expect(body.code).toBe("PLAN_GATE");
    expect(body.flag).toBe("flag.msrp");
    // No self-service fix exists for an admin override — never suggest an upgrade that would do nothing.
    expect(body.upgrade).toEqual(NO_UPGRADE);
    expect(entitlements.resolve).not.toHaveBeenCalled(); // DENY short-circuits before plan resolution
  });

  it("row 3/7: DENY wins on a dark flag too — dark-gate semantics never soften an explicit DENY", async () => {
    delete process.env.PLAN_FLAG_ENFORCEMENT; // flag.reports is genuinely dark here (isDarkFlag)
    reflector.getAllAndOverride.mockReturnValue("flag.reports"); // a DARK_PLAN_FLAGS member
    featureOverrides.get.mockResolvedValue("DENY");
    const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err.getResponse() as PlanGateErrorBody).flag).toBe("flag.reports");
  });

  it("row 3/7: a DENY firing on a dark flag logs a would-deny-style warn line for the blast report", async () => {
    delete process.env.PLAN_FLAG_ENFORCEMENT; // flag.reports is genuinely dark here (isDarkFlag)
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    reflector.getAllAndOverride.mockReturnValue("flag.reports");
    featureOverrides.get.mockResolvedValue("DENY");
    await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("flag=flag.reports"));
    expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("tenant=t1"));
  });

  it("row 4/8: a DENY on an already-enforced (non-dark) flag does NOT log the dark-specific warn", async () => {
    warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    reflector.getAllAndOverride.mockReturnValue("flag.msrp"); // not in DARK_PLAN_FLAGS
    featureOverrides.get.mockResolvedValue("DENY");
    await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("no override (null) falls through to today's plan+dark behaviour unchanged", async () => {
    featureOverrides.get.mockResolvedValue(null);
    reflector.getAllAndOverride.mockReturnValue("flag.msrp");
    entitlements.resolve.mockResolvedValue({ planKey: "ENTERPRISE", flags: ["flag.msrp"] });
    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(entitlements.resolve).toHaveBeenCalledWith("t1");
  });
});
