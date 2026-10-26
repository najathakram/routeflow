import { ADDON_KEY_TO_REGISTRY_KEY, featureDefByKey } from "./feature-registry";
import { LEGACY_ADDON_KEY_TO_SKU } from "./plan-catalog.constants";

/**
 * B552: `ADDON_KEY_TO_REGISTRY_KEY` is the one translation from a `TenantAddon.addonKey` to the
 * registry key that `requires` is indexed by. A 9th addon key added without an entry here makes
 * `checkFeatureRequires` skip its prerequisites silently (the B524 failure). These pins make a
 * missing, mistyped or stale entry a red test instead.
 */
describe("ADDON_KEY_TO_REGISTRY_KEY completeness (B552)", () => {
  it("is exactly today's eight keys: six identity entries and the two flag-bridged ones", () => {
    expect(ADDON_KEY_TO_REGISTRY_KEY).toEqual({
      tobacco_dealer: "tobacco_dealer",
      driver_payments: "driver_payments",
      recurring_routes: "recurring_routes",
      order_delivery: "order_delivery",
      ocr: "ocr",
      developer_mode: "developer_mode",
      msrp: "flag.msrp",
      sales_agents: "flag.sales_agents",
    });
  });

  it("every value is a real registry key", () => {
    const missing = Object.entries(ADDON_KEY_TO_REGISTRY_KEY).filter(
      ([, registryKey]) => !featureDefByKey(registryKey),
    );
    expect(missing).toEqual([]);
  });

  it("every legacy SKU-bridged addon key resolves to a registered row, so its requires are checked", () => {
    // AddonService looks up `ADDON_KEY_TO_REGISTRY_KEY[key] ?? key`: a bridged key with no entry and
    // no row of its own would skip checkFeatureRequires silently (B524).
    const unresolved = Object.keys(LEGACY_ADDON_KEY_TO_SKU).filter(
      (addonKey) => !featureDefByKey(ADDON_KEY_TO_REGISTRY_KEY[addonKey] ?? addonKey),
    );
    expect(unresolved).toEqual([]);
  });

  it("every non-identity entry points at a RequirePlanFlag row and is a legacy SKU bridge", () => {
    const bad = Object.entries(ADDON_KEY_TO_REGISTRY_KEY)
      .filter(([addonKey, registryKey]) => addonKey !== registryKey)
      .filter(
        ([addonKey, registryKey]) =>
          featureDefByKey(registryKey)?.gate.via !== "RequirePlanFlag" ||
          LEGACY_ADDON_KEY_TO_SKU[addonKey] === undefined,
      )
      .map(([addonKey]) => addonKey);
    expect(bad).toEqual([]);
  });
});
