import { ExecutionContext, ForbiddenException } from "@nestjs/common";
import { RouteRunsController } from "./routes.controller";
import { DriverPaymentsGuard } from "./driver-payments.guard";

/**
 * Pins the driver_payments gate (owner decision 2026-08-24): at-door MONEY
 * collection is per-tenant opt-in, but stop COMPLETION — including the $0
 * "on account" close, which uses the same complete-with-payment endpoint for
 * its delivered-basis invoice reconcile — must keep working for every tenant.
 * Hence a body-aware guard on the endpoint rather than a blanket addon gate.
 */
describe("DriverPaymentsGuard (driver_payments addon gate)", () => {
  const ctx = (body: unknown, tenantId: string | null = "t1"): ExecutionContext =>
    ({
      switchToHttp: () => ({ getRequest: () => ({ user: { tenantId }, body }) }),
    }) as unknown as ExecutionContext;

  const makeGuard = (hasAddon: boolean) => {
    const addonService = { hasAddon: jest.fn().mockResolvedValue(hasAddon) };
    return { guard: new DriverPaymentsGuard(addonService as never), addonService };
  };

  it("is wired onto complete-with-payment but NOT the plain complete endpoint", () => {
    const withPayment: unknown[] =
      Reflect.getMetadata("__guards__", RouteRunsController.prototype.completeWithPayment) ?? [];
    const plain: unknown[] =
      Reflect.getMetadata("__guards__", RouteRunsController.prototype.completeStop) ?? [];
    expect(withPayment).toContain(DriverPaymentsGuard);
    expect(plain).not.toContain(DriverPaymentsGuard);
  });

  it("403s a positive-amount payment when the tenant lacks the addon", async () => {
    const { guard } = makeGuard(false);
    await expect(
      guard.canActivate(ctx({ payment: { amount: 25.5, method: "CASH" } })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows a positive-amount payment when the tenant has the addon", async () => {
    const { guard, addonService } = makeGuard(true);
    await expect(
      guard.canActivate(ctx({ payment: { amount: 25.5, method: "CASH" } })),
    ).resolves.toBe(true);
    expect(addonService.hasAddon).toHaveBeenCalledWith("t1", "driver_payments");
  });

  it("allows an on-account completion (no payment) without consulting the addon", async () => {
    const { guard, addonService } = makeGuard(false);
    await expect(guard.canActivate(ctx({ deliveries: [] }))).resolves.toBe(true);
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });

  it("allows a zero-amount payment without consulting the addon (RF-006 owns that rejection)", async () => {
    const { guard, addonService } = makeGuard(false);
    await expect(
      guard.canActivate(ctx({ payment: { amount: 0, method: "ADVANCE" } })),
    ).resolves.toBe(true);
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });

  it("never gates SUPER_ADMIN (no tenant)", async () => {
    const { guard, addonService } = makeGuard(false);
    await expect(
      guard.canActivate(ctx({ payment: { amount: 10, method: "CASH" } }, null)),
    ).resolves.toBe(true);
    expect(addonService.hasAddon).not.toHaveBeenCalled();
  });
});
