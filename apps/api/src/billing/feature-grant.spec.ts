import {
  ADDON_KEY_TO_REGISTRY_KEY,
  FEATURE_REGISTRY,
  OCR_DECISION,
  featureDefByKey,
  registryKeyForAddonKey,
} from "./feature-registry";
import { toFeatureRegistryRow } from "./feature-registry-row";
import { ADDON_SKUS, RETIRED_ADDON_SKUS } from "./plan-catalog.constants";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mirror = require("../../scripts/lib/feature-registry-mirror.cjs") as {
  OVERRIDE_REFUSED_KEYS: Set<string>;
};

/**
 * SA-1106 WP7 (B1): "which path can grant a key" is ONE declaration on the registry row (`grant`).
 * T12 / T21 / the override inventory / M2-1 / M-4 live here; T13 is in feature-override.service.spec.ts
 * and the console's reading of the wire row in FeatureConsole.test.tsx.
 */
describe("registry `grant` declaration (WP7 T12)", () => {
  it("every row declares grant with booleans for override, plan and mode", () => {
    const bad = FEATURE_REGISTRY.filter(
      (f) =>
        typeof f.grant?.override !== "boolean" ||
        typeof f.grant?.plan !== "boolean" ||
        typeof f.grant?.mode !== "boolean",
    ).map((f) => f.key);
    expect(bad).toEqual([]);
  });

  it("an addonKey is only declared on a row an override can reach, and is unique", () => {
    const withKey = FEATURE_REGISTRY.filter((f) => f.grant?.addonKey !== undefined);
    expect(withKey.filter((f) => !f.grant.override).map((f) => f.key)).toEqual([]);
    const keys = withKey.map((f) => f.grant.addonKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("the override inventory: exactly these rows refuse an override (limit_seats -> 409)", () => {
    const refused = FEATURE_REGISTRY.filter((f) => f.grant?.override === false)
      .map((f) => f.key)
      .sort();
    expect(refused).toEqual(
      [
        "ocr",
        "flag.dispatch_live",
        "flag.settlement",
        "flag.api_sso",
        "limit_seats",
        "limit_routes",
        "limit_customers",
        "metered_scans",
        "metered_msgs",
        "catalog_varieties",
        "mixed_packs",
        "routes_dispatch",
        "fulfilment_model",
        "counter_sales",
        "promotions",
      ].sort(),
    );
  });

  it("every config row is picked by a business setting, and only those", () => {
    for (const f of FEATURE_REGISTRY) {
      expect([f.key, f.grant?.mode]).toEqual([f.key, f.config !== undefined]);
    }
  });

  it("the wire row carries grant verbatim", () => {
    for (const f of FEATURE_REGISTRY) expect(toFeatureRegistryRow(f).grant).toEqual(f.grant);
  });

  it("the script mirror refuses exactly the registry's override:false rows", () => {
    const registry = FEATURE_REGISTRY.filter((f) => f.grant?.override === false).map((f) => f.key);
    expect([...mirror.OVERRIDE_REFUSED_KEYS].sort()).toEqual(registry.sort());
  });
});

describe("a gate with no working grant path never enforces (WP7 T21)", () => {
  it("every enforced row can be granted by some path", () => {
    const dead = FEATURE_REGISTRY.filter(
      (f) =>
        f.gate.state === "enforced" &&
        !(f.grant?.override || f.grant?.addonKey || f.grant?.plan || f.grant?.mode),
    ).map((f) => f.key);
    expect(dead).toEqual([]);
  });
});

describe("ADDON_KEY_TO_REGISTRY_KEY is derived, and WP7 changes no answer (neutrality pin)", () => {
  it("is exactly the rows' grant.addonKey", () => {
    expect(ADDON_KEY_TO_REGISTRY_KEY).toEqual(
      Object.fromEntries(
        FEATURE_REGISTRY.filter((f) => f.grant?.addonKey).map((f) => [f.grant.addonKey, f.key]),
      ),
    );
  });

  it("registryKeyForAddonKey answers what the pre-WP7 hand map answered, ocr included", () => {
    const masterMap = {
      tobacco_dealer: "tobacco_dealer",
      driver_payments: "driver_payments",
      recurring_routes: "recurring_routes",
      order_delivery: "order_delivery",
      ocr: "ocr",
      developer_mode: "developer_mode",
      msrp: "flag.msrp",
      sales_agents: "flag.sales_agents",
    };
    for (const [addonKey, registryKey] of Object.entries(masterMap)) {
      expect([addonKey, registryKeyForAddonKey(addonKey)]).toEqual([addonKey, registryKey]);
    }
    // an unknown key names itself, as the old `?? addonKey` did
    expect(registryKeyForAddonKey("something_else")).toBe("something_else");
  });
});

describe("ocr is included on every plan and never denied (SA-1106 A-2, M2-1)", () => {
  const ocr = featureDefByKey("ocr")!;

  it("the decision constant says included_all", () => {
    expect(OCR_DECISION).toBe("included_all");
  });

  it("M2-1: while the decision is included_all the gate stays dark", () => {
    expect(ocr.gate.state).toBe("dark");
  });

  it("the grant offers no add-on key and no override; every plan carries it", () => {
    expect(ocr.grant).toEqual({ override: false, plan: true, mode: false });
  });

  it("its backfill text is the owner ruling, verbatim, and carries no flip date", () => {
    expect(ocr.gate.backfill).toBe(
      "Owner ruling 2026-11-07 (SA-1106 A-2 Q3): included on every plan; the cost guard is the AI cap; never enforced.",
    );
    expect(ocr.gate.reviewBy).toBeUndefined();
  });

  // M2-2 (OCR_PACK_250 in billing.skus -> red) cannot hold yet: the bill path stays until the census
  // and an SA ruling (SA-1106 A-2 section 3). It lands with the cut PR.
  it.todo("M2-2: billing.skus is empty and OCR_PACK_250 is retired (lands with the cut PR)");

  it("meter SCANS stays (the AI cap counts with it)", () => {
    expect(ocr.meter).toBe("SCANS");
  });
});

describe("registry text (M-3, M-4, mailbox help)", () => {
  it("M-3: flag.settlement declares no grant path and is not 'not built yet'", () => {
    const f = featureDefByKey("flag.settlement")!;
    expect(f.grant).toEqual({ override: false, plan: false, mode: false });
    expect(f.incomplete).toBeUndefined();
  });

  it("the mailbox row names the override path, never enableAddon", () => {
    const f = featureDefByKey("email.connected_mailbox")!;
    expect(f.gate.grantPath).not.toMatch(/enableAddon/);
    expect(f.gate.grantPath).toMatch(/Set override/);
    expect(f.grant.addonKey).toBeUndefined();
  });

  it("M-4: ADDON_SKUS has ten names and every retired name is one of them", () => {
    expect(ADDON_SKUS).toHaveLength(10);
    expect(RETIRED_ADDON_SKUS.filter((s) => !ADDON_SKUS.includes(s))).toEqual([]);
  });

  it("M-4: every registry billing sku is a known SKU name, live or retired", () => {
    const known = new Set<string>(ADDON_SKUS);
    const unknown = FEATURE_REGISTRY.flatMap((f) => f.billing.skus.filter((s) => !known.has(s)));
    expect(unknown).toEqual([]);
  });
});
