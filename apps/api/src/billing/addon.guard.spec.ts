import { ExecutionContext, ForbiddenException, Logger } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { AddonGuard } from "./addon.guard";
import { AddonService } from "./addon.service";

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

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    addonService = { getActiveAddons: jest.fn() };
    guard = new AddonGuard(
      reflector as unknown as Reflector,
      addonService as unknown as AddonService,
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
});
