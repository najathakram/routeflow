import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonGuard } from "./addon.guard";
import { AddonService } from "./addon.service";
import { EntitlementsService } from "./entitlements.service";
import { FeatureOverrideService } from "./feature-override.service";

function contextFor(user: { tenantId: string | null } | undefined): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

function darkKeyContext(): ExecutionContext {
  return {
    getHandler: () => ({}),
    getClass: () => ({}),
    switchToHttp: () => ({
      getRequest: () => ({
        user: { tenantId: "tenant-1" },
        method: "POST",
        originalUrl: "/api/v1/vendor-bills/scan-invoice",
      }),
    }),
  } as unknown as ExecutionContext;
}

describe("AddonGuard", () => {
  let guard: AddonGuard;
  let reflector: { getAllAndOverride: jest.Mock };
  let addonService: { getActiveAddons: jest.Mock };
  let entitlements: { isAlwaysEnforcedTenant: jest.Mock };
  let featureOverrides: { getMany: jest.Mock };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    addonService = { getActiveAddons: jest.fn() };
    // Every pre-existing test in this file exercises a non-Lite (non-always-enforced)
    // tenant, so this collaborator-contract addition (WP2) defaults to "not
    // always-enforced" — the same allow-through-dark behavior those tests already
    // assert on. The Lite-specific describe block below overrides this per-test.
    entitlements = { isAlwaysEnforcedTenant: jest.fn().mockResolvedValue(false) };
    // Every pre-existing test in this file exercises a tenant with no override rows, so this
    // collaborator-contract addition (feature-grants PR-1) defaults to "no override" — the
    // same held-addon/dark behavior those tests already assert on. The override-specific
    // describe block below overrides this per-test.
    featureOverrides = { getMany: jest.fn().mockResolvedValue(new Map()) };
    guard = new AddonGuard(
      reflector as unknown as Reflector,
      addonService as unknown as AddonService,
      entitlements as unknown as EntitlementsService,
      featureOverrides as unknown as FeatureOverrideService,
    );
  });

  it("allows requests with no @RequireAddon metadata", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(addonService.getActiveAddons).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN (null tenantId) through any addon gate", async () => {
    reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);

    await expect(guard.canActivate(contextFor({ tenantId: null }))).resolves.toBe(true);
    expect(addonService.getActiveAddons).not.toHaveBeenCalled();
  });

  it("allows tenants with the addon active (legacy single-string metadata)", async () => {
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");
    addonService.getActiveAddons.mockResolvedValue(["tobacco_dealer"]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(addonService.getActiveAddons).toHaveBeenCalledWith("t1");
  });

  it("throws Forbidden when the addon is not active (legacy single-string metadata)", async () => {
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");
    addonService.getActiveAddons.mockResolvedValue([]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("allows when the tenant has any one of several listed addons (any-of)", async () => {
    reflector.getAllAndOverride.mockReturnValue(["recurring_routes", "order_delivery"]);
    addonService.getActiveAddons.mockResolvedValue(["order_delivery"]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(addonService.getActiveAddons).toHaveBeenCalledTimes(1);
    expect(addonService.getActiveAddons).toHaveBeenCalledWith("t1");
  });

  it("throws Forbidden when the tenant has none of several listed addons", async () => {
    reflector.getAllAndOverride.mockReturnValue(["recurring_routes", "order_delivery"]);
    addonService.getActiveAddons.mockResolvedValue([]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).rejects.toThrow(
      ForbiddenException,
    );
    expect(addonService.getActiveAddons).toHaveBeenCalledTimes(1);
  });

  it("never names internal-only keys (developer_mode) in the 403 message", async () => {
    // The web toasts ForbiddenException.message verbatim — a hidden platform-admin
    // flag must not surface as something the tenant could buy or enable.
    reflector.getAllAndOverride.mockReturnValue([
      "recurring_routes",
      "order_delivery",
      "developer_mode",
    ]);
    addonService.getActiveAddons.mockResolvedValue([]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).rejects.toThrow(
      'This feature requires one of these add-ons: "recurring_routes", "order_delivery".',
    );
  });

  it("falls back to single-key wording when only one purchasable key remains", async () => {
    reflector.getAllAndOverride.mockReturnValue(["order_delivery", "developer_mode"]);
    addonService.getActiveAddons.mockResolvedValue([]);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).rejects.toThrow(
      'This feature requires the "order_delivery" add-on.',
    );
  });

  it("reads tenantId from req.user, not the (uninitialized) tenant ALS", async () => {
    // Guards run before TenantInterceptor — a request without a user (e.g.
    // unauthenticated path that slipped past JwtAuthGuard) is treated as
    // tenantless and allowed; RolesGuard/JwtAuthGuard own that rejection.
    reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);

    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);
  });

  describe("REG-OCR-1 / REG-B213 registry-driven observe-first mode", () => {
    let warnSpy: jest.SpyInstance;

    afterEach(() => {
      warnSpy?.mockRestore();
    });

    it("REG-OCR-1 T1: a dark key (ocr) allows a tenant that lacks the add-on row", async () => {
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const result = await guard.canActivate(darkKeyContext()).catch((e) => e);

      expect(result).toBe(true);
    });

    it("REG-OCR-1 T2: a dark-key pass logs one would-deny warning naming the key and tenant", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const result = await guard.canActivate(darkKeyContext()).catch((e) => e);

      // The warn-log oracles come FIRST so this test fails on its own distinguishing value
      // (warn called 0 times) rather than on T1's allow oracle.
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("keys=ocr"));
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("tenant=tenant-1"));
      expect(warnSpy.mock.calls[0][0]).toEqual(
        expect.stringContaining("route=POST /api/v1/vendor-bills/scan-invoice"),
      );
      expect(result).toBe(true);
    });

    it("REG-OCR-1 T3: an enforced key (tobacco_dealer) still denies, now with code ADDON_GATE and the unchanged message", async () => {
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(contextFor({ tenantId: "tenant-1" })).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: "ADDON_GATE",
        addonKeys: ["tobacco_dealer"],
        message: 'This feature requires the "tobacco_dealer" add-on.',
      });
    });

    it("REG-OCR-1 T4: an unregistered key still denies (fail-closed) with code ADDON_GATE", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["not_in_registry"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(contextFor({ tenantId: "tenant-1" })).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: "ADDON_GATE",
        addonKeys: ["not_in_registry"],
        message: 'This feature requires the "not_in_registry" add-on.',
      });
      expect(warnSpy.mock.calls.map((c) => c[0])).not.toContainEqual(
        expect.stringContaining("would deny (dark)"),
      );
    });

    it("REG-OCR-1 T6: a mixed dark+enforced key set still denies and never takes the dark branch", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["ocr", "tobacco_dealer"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(darkKeyContext()).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "ADDON_GATE" });
      expect(err.getResponse().addonKeys).toEqual(
        expect.arrayContaining(["ocr", "tobacco_dealer"]),
      );
      expect(warnSpy.mock.calls.map((c) => c[0])).not.toContainEqual(
        expect.stringContaining("would deny (dark)"),
      );
    });

    it("REG-OCR-1 T7: an enforced deny logs one warning naming the keys, tenant and route", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(contextFor({ tenantId: "tenant-1" })).catch((e) => e);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("addon gate denied"));
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("keys=tobacco_dealer"));
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("tenant=tenant-1"));
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("route="));
      expect(err).toBeInstanceOf(ForbiddenException);
    });

    it("REG-OCR-1 T8: repeated denials for one tenant+key-set log once; another tenant logs again", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      await guard.canActivate(contextFor({ tenantId: "tenant-1" })).catch((e) => e);
      await guard.canActivate(contextFor({ tenantId: "tenant-1" })).catch((e) => e);

      expect(warnSpy).toHaveBeenCalledTimes(1);

      await guard.canActivate(contextFor({ tenantId: "tenant-2" })).catch((e) => e);

      expect(warnSpy).toHaveBeenCalledTimes(2);
      expect(warnSpy.mock.calls[1][0]).toEqual(expect.stringContaining("tenant=tenant-2"));
    });
  });

  describe("WP2 R3a.3/R8.5: always-enforced tenant (Lite) never gets the dark courtesy allow", () => {
    let warnSpy: jest.SpyInstance;

    afterEach(() => {
      warnSpy?.mockRestore();
    });

    it("a dark key set still denies an always-enforced tenant, with the usual ADDON_GATE deny path", async () => {
      entitlements.isAlwaysEnforcedTenant.mockResolvedValue(true);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(darkKeyContext()).catch((e) => e);

      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: "ADDON_GATE",
        addonKeys: ["ocr"],
      });
      expect(entitlements.isAlwaysEnforcedTenant).toHaveBeenCalledWith("tenant-1");
    });

    it("an always-enforced tenant's deny still logs the enforced deny-warn, not the would-deny (dark) one", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      entitlements.isAlwaysEnforcedTenant.mockResolvedValue(true);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      await guard.canActivate(darkKeyContext()).catch((e) => e);

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toEqual(expect.stringContaining("addon gate denied"));
      expect(warnSpy.mock.calls.map((c) => c[0])).not.toContainEqual(
        expect.stringContaining("would deny (dark)"),
      );
    });

    it("an always-enforced tenant that DOES hold the addon is still allowed (the addon check runs first)", async () => {
      entitlements.isAlwaysEnforcedTenant.mockResolvedValue(true);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue(["ocr"]);

      await expect(guard.canActivate(darkKeyContext())).resolves.toBe(true);
      // Held-addon short-circuit precedes the dark-vs-enforced branch entirely.
      expect(entitlements.isAlwaysEnforcedTenant).not.toHaveBeenCalled();
    });

    it("a non-always-enforced tenant is unaffected by isAlwaysEnforcedTenant returning false (regression)", async () => {
      entitlements.isAlwaysEnforcedTenant.mockResolvedValue(false);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      addonService.getActiveAddons.mockResolvedValue([]);

      await expect(guard.canActivate(darkKeyContext())).resolves.toBe(true);
    });
  });

  // Feature-grants PR-1 (owner ruling 2026-09-16): an active override is absolute — it decides
  // before the held-addon/dark check, regardless of gate mode. Only its absence falls through to
  // today's held/dark behaviour (proven byte-identical by every test above, none of which
  // configures featureOverrides.getMany beyond its "no override" default empty Map).
  describe("feature-grants PR-1: override precedence (absolute, ignores held-addon and dark/enforced)", () => {
    let warnSpy: jest.SpyInstance;

    afterEach(() => {
      warnSpy?.mockRestore();
    });

    it("row 6: GRANT wins even though the tenant doesn't hold the addon and the gate is enforced", async () => {
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["tobacco_dealer", "GRANT"]]));
      addonService.getActiveAddons.mockResolvedValue([]);

      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
      expect(addonService.getActiveAddons).not.toHaveBeenCalled(); // GRANT short-circuits first
    });

    it("row 5: GRANT wins on a dark key too (uniform — dark/enforced is irrelevant once GRANT applies)", async () => {
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["ocr", "GRANT"]]));

      await expect(guard.canActivate(darkKeyContext())).resolves.toBe(true);
    });

    it("row 4/8: DENY wins over a held addon on an enforced gate", async () => {
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["tobacco_dealer", "DENY"]]));
      addonService.getActiveAddons.mockResolvedValue(["tobacco_dealer"]); // genuinely held

      const err = await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({
        code: "ADDON_GATE",
        addonKeys: ["tobacco_dealer"],
      });
    });

    it("row 3/7: DENY wins on a dark key too — dark-gate semantics never soften an explicit DENY", async () => {
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["ocr", "DENY"]]));

      const err = await guard.canActivate(darkKeyContext()).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect(err.getResponse()).toMatchObject({ code: "ADDON_GATE" });
    });

    it("row 3/7: a DENY firing on a dark key logs a would-deny-style warn line for the blast report", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["ocr"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["ocr", "DENY"]]));

      await guard.canActivate(darkKeyContext()).catch((e) => e);

      const messages = warnSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContainEqual(
        expect.stringContaining("addon gate override-denied on a dark key"),
      );
      expect(messages).toContainEqual(expect.stringContaining("keys=ocr"));
      // Still logs the usual enforced-deny warning too — the override doesn't replace it.
      expect(messages).toContainEqual(expect.stringContaining("addon gate denied"));
    });

    it("row 4/8: a DENY on an already-enforced (non-dark) key does NOT log the dark-specific warn", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["tobacco_dealer", "DENY"]]));
      addonService.getActiveAddons.mockResolvedValue([]);

      await guard.canActivate(contextFor({ tenantId: "t1" })).catch((e) => e);

      const messages = warnSpy.mock.calls.map((c) => c[0]);
      expect(messages).not.toContainEqual(expect.stringContaining("override-denied on a dark key"));
    });

    it("no override (empty Map) falls through to today's held/dark behaviour unchanged", async () => {
      reflector.getAllAndOverride.mockReturnValue(["tobacco_dealer"]);
      featureOverrides.getMany.mockResolvedValue(new Map());
      addonService.getActiveAddons.mockResolvedValue(["tobacco_dealer"]);

      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    });

    it("any-of: a DENY on one key does not block a sibling key that is genuinely held", async () => {
      reflector.getAllAndOverride.mockReturnValue(["recurring_routes", "order_delivery"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["recurring_routes", "DENY"]]));
      addonService.getActiveAddons.mockResolvedValue(["order_delivery"]);

      await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    });

    it("any-of: a DENY on one key does not block a sibling key covered by the dark courtesy allow", async () => {
      reflector.getAllAndOverride.mockReturnValue(["ocr", "recurring_routes"]);
      featureOverrides.getMany.mockResolvedValue(new Map([["recurring_routes", "DENY"]]));
      addonService.getActiveAddons.mockResolvedValue([]);

      // ocr is dark and carries no override, so it alone should still earn the courtesy allow.
      await expect(guard.canActivate(darkKeyContext())).resolves.toBe(true);
    });

    it("any-of: every key denied still denies, even though one denied key's own gate is dark", async () => {
      warnSpy = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      reflector.getAllAndOverride.mockReturnValue(["ocr", "tobacco_dealer"]);
      featureOverrides.getMany.mockResolvedValue(
        new Map([
          ["ocr", "DENY"],
          ["tobacco_dealer", "DENY"],
        ]),
      );
      addonService.getActiveAddons.mockResolvedValue([]);

      const err = await guard.canActivate(darkKeyContext()).catch((e) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      const messages = warnSpy.mock.calls.map((c) => c[0]);
      expect(messages).toContainEqual(expect.stringContaining("keys=ocr"));
    });
  });
});
