import { FEATURE_REGISTRY } from "./feature-registry";
import { resolveOneKey, ResolveContext } from "./feature-resolver.service";

/**
 * B508: the platform-admin tenant page used to carry legacy "MSRP on invoices" / "Sales agents
 * & commissions" toggle cards that wrote `TenantAddon{addonKey:"msrp"|"sales_agents"}`. Neither
 * key is ever read for enforcement — both features are actually gated by
 * `@RequirePlanFlag("flag.msrp"|"flag.sales_agents")`, resolved from the tenant's plan/override
 * flags, never from the addon table. The toggles were deleted (B508) because they were inert
 * and actively misleading; this pins that "inert" claim so a future change can't quietly wire
 * the addon table back in without a red test.
 */
describe("REG-B508: flag.msrp / flag.sales_agents resolve through the plan-flag path only", () => {
  const msrp = FEATURE_REGISTRY.find((f) => f.key === "flag.msrp")!;
  const salesAgents = FEATURE_REGISTRY.find((f) => f.key === "flag.sales_agents")!;

  it("both registry rows are RequirePlanFlag-gated, not addon-keyed", () => {
    expect(msrp.gate.via).toBe("RequirePlanFlag");
    expect(salesAgents.gate.via).toBe("RequirePlanFlag");
  });

  it("an active legacy 'msrp'/'sales_agents' TenantAddon row grants nothing — the addon table is never consulted for these keys", () => {
    // Simulates the orphaned rows B508 leaves behind: the legacy addonKey is "active", but
    // that is not the registry key ("flag.msrp"/"flag.sales_agents"), and no plan/override
    // flag is present either.
    const ctx: ResolveContext = {
      overrides: new Map(),
      activeAddonSet: new Set(["msrp", "sales_agents"]),
      planFeatureFlags: new Set(),
      entFlags: [],
      activeSkuSet: new Set(),
    };

    expect(resolveOneKey(msrp, ctx)).toMatchObject({ effective: false, source: "NONE" });
    expect(resolveOneKey(salesAgents, ctx)).toMatchObject({ effective: false, source: "NONE" });
  });

  it("only the dotted flag key (plan flags or an override) grants these features", () => {
    const grantedByPlan: ResolveContext = {
      overrides: new Map(),
      activeAddonSet: new Set(),
      planFeatureFlags: new Set(["flag.msrp", "flag.sales_agents"]),
      entFlags: ["flag.msrp", "flag.sales_agents"],
      activeSkuSet: new Set(),
    };
    expect(resolveOneKey(msrp, grantedByPlan)).toMatchObject({
      effective: true,
      source: "PRESET",
    });
    expect(resolveOneKey(salesAgents, grantedByPlan)).toMatchObject({
      effective: true,
      source: "PRESET",
    });

    const grantedByOverride: ResolveContext = {
      overrides: new Map([
        ["flag.msrp", "GRANT"],
        ["flag.sales_agents", "GRANT"],
      ]),
      activeAddonSet: new Set(),
      planFeatureFlags: new Set(),
      entFlags: [],
      activeSkuSet: new Set(),
    };
    expect(resolveOneKey(msrp, grantedByOverride)).toMatchObject({
      effective: true,
      source: "OVERRIDE_GRANT",
    });
    expect(resolveOneKey(salesAgents, grantedByOverride)).toMatchObject({
      effective: true,
      source: "OVERRIDE_GRANT",
    });
  });
});
