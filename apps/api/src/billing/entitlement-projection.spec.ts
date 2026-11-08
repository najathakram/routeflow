import { heldAddonKeys } from "./fulfilment-capability";
import { computeServedFlags } from "./plan-flag-policy";
import { resolveOneKey, type ResolveContext } from "./feature-resolver.service";
import { featureDefByKey } from "./feature-registry";

/**
 * SA-1106 WP8 (T17): the three things a client can read (`/tenants/me/addons`, `subscription.flags`,
 * `/tenants/me/features`) answer the same for an override holder, and the legacy names (`msrp`,
 * `sales_agents`) are present. Each projection is the real function behind its endpoint.
 */
describe("the three client projections agree for an override holder (WP8, T17)", () => {
  const overrides = new Map<string, "GRANT" | "DENY">([
    ["flag.msrp", "GRANT"],
    ["flag.sales_agents", "GRANT"],
    ["driver_payments", "GRANT"],
    ["flag.reports", "DENY"],
  ]);
  const addons = (rows: string[]) =>
    heldAddonKeys(
      { getActiveAddons: jest.fn().mockResolvedValue(rows) },
      { allActive: jest.fn().mockResolvedValue(overrides) },
      "t1",
    );
  const strictOf = (key: string, ov = overrides) =>
    resolveOneKey(featureDefByKey(key)!, {
      overrides: ov,
      activeAddonSet: new Set<string>(),
      entFlags: [],
      billed: new Set<string>(),
      courtesy: () => false,
    } as unknown as ResolveContext).strict;

  it("GRANT: /me/addons, subscription.flags and the resolver all show it, legacy names kept", async () => {
    const held = await addons([]);
    const served = computeServedFlags("GROWTH", [], overrides, {} as NodeJS.ProcessEnv);
    for (const [flag, legacy] of [
      ["flag.msrp", "msrp"],
      ["flag.sales_agents", "sales_agents"],
    ]) {
      expect(held.has(legacy)).toBe(true);
      expect(served).toContain(flag);
      expect(strictOf(flag)).toBe(true);
    }
    expect(held.has("driver_payments")).toBe(true);
    expect(strictOf("driver_payments")).toBe(true);
  });

  it("DENY wins over a held row and a plan flag in all three", async () => {
    const held = await addons(["flag.reports", "msrp"]);
    const denyMsrp = new Map<string, "GRANT" | "DENY">([["flag.msrp", "DENY"]]);
    const heldDeny = await heldAddonKeys(
      { getActiveAddons: jest.fn().mockResolvedValue(["msrp"]) },
      { allActive: jest.fn().mockResolvedValue(denyMsrp) },
      "t1",
    );
    expect(held.has("msrp")).toBe(true); // GRANT in this fixture
    expect(heldDeny.has("msrp")).toBe(false);
    expect(computeServedFlags("SCALE", ["flag.msrp"], denyMsrp)).not.toContain("flag.msrp");
    expect(strictOf("flag.msrp", denyMsrp)).toBe(false);
  });
});
