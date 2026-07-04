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
  let addonService: { hasAddon: jest.Mock };

  beforeEach(() => {
    reflector = { getAllAndOverride: jest.fn() };
    addonService = { hasAddon: jest.fn() };
    guard = new AddonGuard(
      reflector as unknown as Reflector,
      addonService as unknown as AddonService,
    );
  });

  it("allows requests with no @RequireAddon metadata", async () => {
    reflector.getAllAndOverride.mockReturnValue(undefined);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });

  it("allows SUPER_ADMIN (null tenantId) through any addon gate", async () => {
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");

    await expect(guard.canActivate(contextFor({ tenantId: null }))).resolves.toBe(true);
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });

  it("allows tenants with the addon active", async () => {
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");
    addonService.hasAddon.mockResolvedValue(true);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).resolves.toBe(true);
    expect(addonService.hasAddon).toHaveBeenCalledWith("t1", "tobacco_dealer");
  });

  it("throws Forbidden when the addon is not active", async () => {
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");
    addonService.hasAddon.mockResolvedValue(false);

    await expect(guard.canActivate(contextFor({ tenantId: "t1" }))).rejects.toThrow(
      ForbiddenException,
    );
  });

  it("reads tenantId from req.user, not the (uninitialized) tenant ALS", async () => {
    // Guards run before TenantInterceptor — a request without a user (e.g.
    // unauthenticated path that slipped past JwtAuthGuard) is treated as
    // tenantless and allowed; RolesGuard/JwtAuthGuard own that rejection.
    reflector.getAllAndOverride.mockReturnValue("tobacco_dealer");

    await expect(guard.canActivate(contextFor(undefined))).resolves.toBe(true);
  });
});
