import { FeatureConfigController } from "./feature-config.controller";

/**
 * Feature grants v2 brief C (PR-4), oracle 3 (HTTP shape) — direct instantiation (no Nest
 * module/guard bootstrap needed), same pattern as settings-billing.controller.spec.ts. Guard
 * wiring (JwtAuthGuard + SuperAdminGuard) is exercised structurally, not re-tested here.
 */
function make() {
  const featureConfig = {
    getState: jest.fn(),
    set: jest.fn(),
    clear: jest.fn(),
  } as any;
  const controller = new FeatureConfigController(featureConfig);
  return { controller, featureConfig };
}

const admin = { sub: "admin-1", tenantId: null, role: "SUPER_ADMIN" } as any;

describe("FeatureConfigController", () => {
  it("GET returns the FeatureModeState for {tenantId, key}", async () => {
    const { controller, featureConfig } = make();
    featureConfig.getState.mockResolvedValue({
      value: "unset",
      effective: "unset",
      source: "REGISTRY_DEFAULT",
      allowed: ["unset"],
      blocked: ["scheduled", "adhoc", "mixed"],
    });

    const result = await controller.getState("tenant-a", "routes_dispatch");

    expect(featureConfig.getState).toHaveBeenCalledWith("tenant-a", "routes_dispatch");
    expect(result.effective).toBe("unset");
  });

  it("PUT calls set() then re-reads getState() for the response", async () => {
    const { controller, featureConfig } = make();
    featureConfig.set.mockResolvedValue(undefined);
    featureConfig.getState.mockResolvedValue({
      value: "scheduled",
      effective: "scheduled",
      source: "TENANT",
      allowed: ["scheduled"],
      blocked: [],
    });

    const result = await controller.setState(
      "tenant-a",
      "routes_dispatch",
      { mode: "scheduled", reason: "pilot" },
      admin,
    );

    expect(featureConfig.set).toHaveBeenCalledWith(
      "tenant-a",
      "routes_dispatch",
      "scheduled",
      "pilot",
      "admin-1",
    );
    expect(result.value).toBe("scheduled");
  });

  it("PUT propagates a 409/400 from the service untouched (never swallowed)", async () => {
    const { controller, featureConfig } = make();
    const conflict = Object.assign(new Error("conflict"), { status: 409 });
    featureConfig.set.mockRejectedValue(conflict);

    await expect(
      controller.setState("tenant-a", "routes_dispatch", { mode: "scheduled", reason: "x" }, admin),
    ).rejects.toBe(conflict);
    expect(featureConfig.getState).not.toHaveBeenCalled();
  });

  it("DELETE clears then re-reads getState() for the response", async () => {
    const { controller, featureConfig } = make();
    featureConfig.clear.mockResolvedValue(undefined);
    featureConfig.getState.mockResolvedValue({
      value: "unset",
      effective: "unset",
      source: "REGISTRY_DEFAULT",
      allowed: ["unset"],
      blocked: ["scheduled", "adhoc", "mixed"],
    });

    const result = await controller.clearState("tenant-a", "routes_dispatch", admin);

    expect(featureConfig.clear).toHaveBeenCalledWith(
      "tenant-a",
      "routes_dispatch",
      "cleared via platform-admin",
      "admin-1",
    );
    expect(result.source).toBe("REGISTRY_DEFAULT");
  });

  it("tenant isolation: a PUT for tenant B is called with tenant B's id, never tenant A's", async () => {
    const { controller, featureConfig } = make();
    featureConfig.set.mockResolvedValue(undefined);
    featureConfig.getState.mockResolvedValue({
      value: "adhoc",
      effective: "adhoc",
      source: "TENANT",
      allowed: ["adhoc"],
      blocked: [],
    });

    await controller.setState("tenant-b", "routes_dispatch", { mode: "adhoc", reason: "r" }, admin);

    const call = featureConfig.set.mock.calls[0];
    expect(call[0]).toBe("tenant-b");
    expect(call[0]).not.toBe("tenant-a");
  });
});
