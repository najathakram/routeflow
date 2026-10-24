/**
 * Settings registry, `featureConfig` home: a row's key must be a feature-registry key that has a config
 * block (the api owns that registry, so it passes the key list to the shared validator).
 */
import { SETTINGS_REGISTRY, validateSettingsRegistry, type SettingRow } from "@routeflow/types";
import { FEATURE_REGISTRY } from "../billing/feature-registry";

const configKeys = FEATURE_REGISTRY.filter((f) => f.config).map((f) => f.key);

const row = (over: Partial<SettingRow>): SettingRow => ({
  key: "fulfilment_model",
  home: "featureConfig",
  kind: "behaviour",
  status: "live",
  screen: "/settings?tab=fulfilment#delivery-method",
  adminOnly: true,
  ...over,
});

describe("settings registry — featureConfig home", () => {
  it("the shipped registry is valid against the real feature registry", () => {
    expect(validateSettingsRegistry(SETTINGS_REGISTRY, configKeys)).toEqual([]);
  });

  it("registers the two fulfilment keys as admin-only live behaviour rows", () => {
    for (const key of ["fulfilment_model", "counter_sales"]) {
      expect(SETTINGS_REGISTRY.find((r) => r.key === key)).toMatchObject({
        home: "featureConfig",
        kind: "behaviour",
        status: "live",
        adminOnly: true,
      });
      expect(configKeys).toContain(key);
    }
    expect(SETTINGS_REGISTRY.find((r) => r.key === "fulfilment_model")!.screen).toBe(
      "/settings?tab=fulfilment#delivery-method",
    );
    expect(SETTINGS_REGISTRY.find((r) => r.key === "counter_sales")!.screen).toBe(
      "/settings?tab=fulfilment#counter-sales",
    );
  });

  it("a featureConfig row whose key is not a feature-registry config key fails", () => {
    expect(
      validateSettingsRegistry([row({ key: "no_such_feature" })], configKeys).join("\n"),
    ).toMatch(/not a feature-registry key with a config block/);
  });

  it("a feature-registry key WITHOUT a config block fails", () => {
    const noConfig = FEATURE_REGISTRY.find((f) => !f.config)!.key;
    expect(validateSettingsRegistry([row({ key: noConfig })], configKeys).join("\n")).toMatch(
      /not a feature-registry key/,
    );
  });

  it("a featureConfig row must be a behaviour mode", () => {
    expect(validateSettingsRegistry([row({ kind: "config" })], configKeys).join("\n")).toMatch(
      /behaviour modes only/,
    );
  });

  it("without a key list the shape rules still run (the shared package cannot see the registry)", () => {
    expect(validateSettingsRegistry([row({ key: "anything" })])).toEqual([]);
  });
});
