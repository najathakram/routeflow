import { PlatformAdminController } from "./platform-admin.controller";
import { SuperAdminGuard } from "../tenant/super-admin.guard";

/** W-1338 PR-1: the open-link routes are super-admin only (class-level guard) and carry the TENANT id from the route. */
describe("PlatformAdminController open-link routes", () => {
  const billing = {
    getOpenLink: jest.fn().mockResolvedValue(null),
    cancelOpenLink: jest.fn().mockResolvedValue({ cancelled: false }),
  };
  const controller: PlatformAdminController = Object.assign(
    Object.create(PlatformAdminController.prototype),
    { billingService: billing },
  );

  it("the class guard list includes SuperAdminGuard", () => {
    expect(Reflect.getMetadata("__guards__", PlatformAdminController)).toContain(SuperAdminGuard);
  });

  it("GET reads the route's tenant and POST cancel expires the route's tenant", async () => {
    await controller.getOpenLink("t9");
    await controller.cancelOpenLink("t9");
    expect(billing.getOpenLink).toHaveBeenCalledWith("t9");
    expect(billing.cancelOpenLink).toHaveBeenCalledWith("t9");
  });
});
