import { ExecutionContext, ForbiddenException } from "@nestjs/common";
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
});
