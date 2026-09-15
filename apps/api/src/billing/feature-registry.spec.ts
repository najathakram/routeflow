import * as fs from "node:fs";
import * as path from "node:path";
import {
  ADDON_GATE_REGISTRY,
  addonGateState,
  FEATURE_REGISTRY,
  type FeatureDef,
} from "./feature-registry";

const SRC_ROOT = path.resolve(__dirname, "..");
const PRISMA_ROOT = path.resolve(__dirname, "..", "..", "prisma");

/** Verbatim copy of today's addon-gate-registry.ts literal (this file's parent commit) — the
 * zero-diff proof below fails loudly if a future edit changes a RequireAddon row's routes/
 * grantPath/backfill without updating BOTH this const and the registry together. */
const EXPECTED_LEGACY_REGISTRY = {
  ocr: {
    state: "dark",
    added: "2026-08-29",
    routes: [
      "POST /vendor-bills/scan-invoice",
      "POST /bookkeeping/expenses/:id/extract-items",
      "POST /import/batch/:id/scan",
      "POST /supplier-statements/scan",
    ],
    grantPath:
      'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "ocr")',
    backfill:
      "Owner decision 2026-09-05: OCR available to all tenants; gate stays dark until OCR is " +
      "monetized; no grants required",
    reviewBy: "2027-03-31",
  },
  tobacco_dealer: {
    state: "enforced",
    added: "2026-07-04",
    routes: [
      "GET /regulated/ledger",
      "GET /regulated/reports/preview",
      "GET /regulated/reports/csv",
      "GET /regulated/filings",
      "POST /regulated/filings/prepare",
      "GET /regulated/filings/:id/csv",
      "GET /regulated/filings/:id/pdf",
      "ALL /tobacco/* (class-level)",
    ],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "tobacco_dealer")',
    backfill: "Live before the registry existed (regulated program); no change.",
  },
  recurring_routes: {
    state: "enforced",
    added: "2026-08-29",
    routes: [
      "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of order_delivery/developer_mode)",
      "ALL /routes/* (route-optimization.controller.ts, class-level, any-of order_delivery/developer_mode)",
      "ALL /routes/* (routes.controller.ts, class-level, any-of order_delivery/developer_mode)",
      "ALL /route-runs/* (routes.controller.ts, class-level, any-of order_delivery/developer_mode)",
      "PATCH /trips/routes/:routeId/planning (any-of order_delivery/developer_mode)",
      "ALL /drivers/* (class-level, any-of order_delivery/developer_mode)",
    ],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "recurring_routes")',
    backfill:
      "Live before the registry existed; any-of with order_delivery/developer_mode; no change.",
  },
  order_delivery: {
    state: "enforced",
    added: "2026-08-29",
    routes: [
      "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of recurring_routes/developer_mode)",
      "ALL /routes/* (route-optimization.controller.ts, class-level, any-of recurring_routes/developer_mode)",
      "ALL /routes/* (routes.controller.ts, class-level, any-of recurring_routes/developer_mode)",
      "ALL /route-runs/* (routes.controller.ts, class-level, any-of recurring_routes/developer_mode)",
      "ALL /trips/* (class-level, any-of developer_mode)",
      "PATCH /trips/routes/:routeId/planning (any-of recurring_routes/developer_mode)",
      "ALL /drivers/* (class-level, any-of recurring_routes/developer_mode)",
    ],
    grantPath: 'Platform Admin → Tenants → [tenant] → add-ons (addonKey "order_delivery")',
    backfill: "Live before the registry existed; no change.",
  },
  crm_gohighlevel: {
    state: "dark",
    added: "2026-09-11",
    routes: [
      "GET /crm/gohighlevel",
      "PATCH /crm/gohighlevel/connection",
      "POST /crm/gohighlevel/connection/test",
      "DELETE /crm/gohighlevel/connection",
      "GET /crm/gohighlevel/pipelines",
      "PATCH /crm/gohighlevel/config",
      "POST /crm/gohighlevel/sync",
      "GET /crm/gohighlevel/handoffs",
      "POST /crm/gohighlevel/handoffs/:id/retry",
      "POST /crm/gohighlevel/handoffs/:id/dismiss",
      "POST /crm/gohighlevel/import-existing/preview",
      "POST /crm/gohighlevel/import-existing",
    ],
    grantPath:
      'Platform Admin → Tenants → [tenant] → add-ons (AddonService.enableAddon writes addonKey "crm_gohighlevel")',
    backfill:
      "New feature 2026-09-11: no tenant has a connection; gate stays dark through the pilot. " +
      "Owner ruling 2026-09-12: BILLABLE add-on at $9.99/month — a follow-up publishes the sellable " +
      "AddonSku (FLAT, granting this key) in the next catalog version; flip to enforced only after that " +
      "SKU exists, the pilot tenant holds it, and the blast-radius report is clean",
    reviewBy: "2027-03-11",
  },
  developer_mode: {
    state: "enforced",
    added: "2026-08-21",
    routes: [
      "ALL /route-runs/* (route-optimization.controller.ts, class-level, any-of recurring_routes/order_delivery)",
      "ALL /routes/* (route-optimization.controller.ts, class-level, any-of recurring_routes/order_delivery)",
      "ALL /routes/* (routes.controller.ts, class-level, any-of recurring_routes/order_delivery)",
      "ALL /route-runs/* (routes.controller.ts, class-level, any-of recurring_routes/order_delivery)",
      "ALL /trips/* (class-level, any-of order_delivery)",
      "PATCH /trips/routes/:routeId/planning (any-of recurring_routes/order_delivery)",
      "ALL /drivers/* (class-level, any-of recurring_routes/order_delivery)",
    ],
    grantPath:
      "Platform Admin internal switch (never named in tenant-facing text — see INTERNAL_ADDON_KEYS).",
    backfill: "Internal flag; no change.",
  },
};

/** key -> files that carry a string-literal `@Decorator("key")` call, by decorator name. */
function decoratorSites(decorator: "RequireAddon" | "RequirePlanFlag"): Map<string, string[]> {
  const files = (fs.readdirSync(SRC_ROOT, { recursive: true }) as string[])
    .map(String)
    .filter((f) => f.endsWith(".controller.ts"))
    .map((f) => path.join(SRC_ROOT, f));
  const sites = new Map<string, string[]>();
  const callRe = new RegExp(`@${decorator}\\(([^)]*)\\)`, "g");
  for (const file of files) {
    const text = fs.readFileSync(file, "utf8");
    for (const call of text.matchAll(callRe)) {
      for (const lit of call[1].matchAll(/"([^"]+)"/g)) {
        const list = sites.get(lit[1]) ?? [];
        list.push(path.relative(SRC_ROOT, file));
        sites.set(lit[1], list);
      }
    }
  }
  return sites;
}

/** A `reviewBy` that is missing, malformed, unparseable, or in the past counts as expired. */
function reviewByExpired(reviewBy: string | undefined, todayUtc: number): boolean {
  if (!reviewBy || !/^\d{4}-\d{2}-\d{2}$/.test(reviewBy)) return true;
  const t = new Date(`${reviewBy}T00:00:00Z`).getTime();
  return !(t >= todayUtc);
}

describe("FEATURE_REGISTRY (feature grants PR-1)", () => {
  const byKey = new Map(FEATURE_REGISTRY.map((f) => [f.key, f]));

  it("zero-diff: ADDON_GATE_REGISTRY still equals today's literal, byte for byte", () => {
    expect(ADDON_GATE_REGISTRY).toEqual(EXPECTED_LEGACY_REGISTRY);
  });

  it("addonGateState behaves exactly as before", () => {
    expect(addonGateState("not_in_registry")).toBe("enforced");
    expect(addonGateState("ocr")).toBe("dark");
  });

  it("no duplicate keys", () => {
    const keys = FEATURE_REGISTRY.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  // Non-vacuity floors (mirrors addon-gate-registry.spec.ts's P1e): a scanner that silently
  // finds zero call sites (wrong root dir, decorator renamed, regex broken by a refactor)
  // would otherwise make every "missing" check below pass by having nothing to check.
  // Counts are the real repo-wide totals measured when this spec was written — a drop below
  // them means either a real call site vanished (investigate) or the scanner broke (fix it).
  const REQUIRE_ADDON_MIN_SITES: Record<string, number> = {
    ocr: 4,
    tobacco_dealer: 8,
    recurring_routes: 6,
    order_delivery: 7,
    developer_mode: 7,
    crm_gohighlevel: 12,
  };
  const REQUIRE_PLAN_FLAG_MIN_SITES: Record<string, number> = {
    "flag.msrp": 1,
    "flag.sales_agents": 2,
    "flag.analytics": 1,
    "flag.forecasting": 2,
    "flag.reports": 1,
    "flag.returns": 1,
    "flag.ap_bills": 1,
    "flag.pricing_tiers": 3,
    "flag.import_integrations": 1,
  };

  describe("@RequireAddon call sites", () => {
    const sites = decoratorSites("RequireAddon");

    it("the scanner is not vacuous (found at least the expected key counts)", () => {
      expect(sites.size).toBeGreaterThanOrEqual(Object.keys(REQUIRE_ADDON_MIN_SITES).length);
      for (const [key, min] of Object.entries(REQUIRE_ADDON_MIN_SITES)) {
        expect(sites.get(key)?.length ?? 0).toBeGreaterThanOrEqual(min);
      }
    });

    it("every @RequireAddon literal found in a controller has a matching FEATURE_REGISTRY row", () => {
      const missing = [...sites.keys()].filter((key) => {
        const row = byKey.get(key);
        return !row || row.gate.via !== "RequireAddon";
      });
      expect(missing).toEqual([]);
    });

    it("every FEATURE_REGISTRY RequireAddon row is actually found by the scanner (reverse check)", () => {
      const registryKeys = FEATURE_REGISTRY.filter((f) => f.gate.via === "RequireAddon").map(
        (f) => f.key,
      );
      const unscanned = registryKeys.filter((key) => !sites.has(key));
      expect(unscanned).toEqual([]);
    });
  });

  describe("@RequirePlanFlag call sites", () => {
    const sites = decoratorSites("RequirePlanFlag");

    it("the scanner is not vacuous (found at least the expected key counts)", () => {
      expect(sites.size).toBeGreaterThanOrEqual(Object.keys(REQUIRE_PLAN_FLAG_MIN_SITES).length);
      for (const [key, min] of Object.entries(REQUIRE_PLAN_FLAG_MIN_SITES)) {
        expect(sites.get(key)?.length ?? 0).toBeGreaterThanOrEqual(min);
      }
    });

    it("every @RequirePlanFlag literal found in a controller has a matching FEATURE_REGISTRY row", () => {
      const missing = [...sites.keys()].filter((key) => {
        const row = byKey.get(key);
        return !row || row.gate.via !== "RequirePlanFlag";
      });
      expect(missing).toEqual([]);
    });

    it("every FEATURE_REGISTRY RequirePlanFlag row is actually found by the scanner (reverse check)", () => {
      const registryKeys = FEATURE_REGISTRY.filter((f) => f.gate.via === "RequirePlanFlag").map(
        (f) => f.key,
      );
      const unscanned = registryKeys.filter((key) => !sites.has(key));
      expect(unscanned).toEqual([]);
    });
  });

  it("every RequireAddon/RequirePlanFlag row has at least one live call site listed", () => {
    const stale = FEATURE_REGISTRY.filter(
      (f) =>
        (f.gate.via === "RequireAddon" || f.gate.via === "RequirePlanFlag") &&
        f.gate.routes.length === 0,
    ).map((f) => f.key);
    expect(stale).toEqual([]);
  });

  it("every dark row's reviewBy is not expired (UTC)", () => {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const expired = FEATURE_REGISTRY.filter((f) => f.gate.state === "dark")
      .filter((f) => reviewByExpired(f.gate.reviewBy, todayUtc))
      .map((f) => `${f.key}:${f.gate.reviewBy ?? "missing"}`);
    expect(expired).toEqual([]);
  });

  it("catalog-key coverage: every flag/addon literal in publish-plan-catalog-v8..v11 resolves to a key or catalogFlag", () => {
    const catalogFiles = ["v8", "v9", "v10", "v11"].map((v) =>
      path.join(PRISMA_ROOT, `publish-plan-catalog-${v}.ts`),
    );
    const literalRe = /"((?:flag|addon)\.[a-zA-Z0-9_]+)"/g;
    const found = new Set<string>();
    for (const file of catalogFiles) {
      const text = fs.readFileSync(file, "utf8");
      for (const m of text.matchAll(literalRe)) found.add(m[1]);
    }
    expect(found.size).toBeGreaterThan(0);

    const knownKeys = new Set(FEATURE_REGISTRY.map((f) => f.key));
    const knownCatalogFlags = new Set(
      FEATURE_REGISTRY.map((f) => f.billing.catalogFlag).filter(
        (v): v is string => v !== undefined,
      ),
    );
    const unresolved = [...found].filter(
      (lit) => !knownKeys.has(lit) && !knownCatalogFlags.has(lit),
    );
    expect(unresolved).toEqual([]);
  });

  it("DARK_PLAN_FLAGS (plan-flag.guard.ts) parity: exactly the dark RequirePlanFlag keys", () => {
    const guardText = fs.readFileSync(path.join(SRC_ROOT, "billing", "plan-flag.guard.ts"), "utf8");
    const setMatch = guardText.match(/DARK_PLAN_FLAGS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
    expect(setMatch).not.toBeNull();
    const guardKeys = [...(setMatch?.[1].matchAll(/"([^"]+)"/g) ?? [])].map((m) => m[1]).sort();

    const registryDarkPlanFlagKeys = FEATURE_REGISTRY.filter(
      (f) => f.gate.via === "RequirePlanFlag" && f.gate.state === "dark",
    )
      .map((f) => f.key)
      .sort();

    expect(registryDarkPlanFlagKeys).toEqual(guardKeys);
  });

  it("key convention: non-dotted keys are lower_snake_case, <= 50 chars", () => {
    const bad = FEATURE_REGISTRY.filter(
      (f) => !f.key.startsWith("flag.") && !f.key.startsWith("addon."),
    )
      .filter((f) => !/^[a-z][a-z0-9_]*$/.test(f.key) || f.key.length > 50)
      .map((f) => f.key);
    expect(bad).toEqual([]);
  });

  it("requires/conflicts reference real keys and requires.allOf/anyOf never cycles back", () => {
    const keys = new Set(FEATURE_REGISTRY.map((f) => f.key));
    const badRefs: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      const refs = [
        ...(f.requires?.allOf ?? []),
        ...(f.requires?.anyOf ?? []),
        ...(f.conflicts ?? []),
      ];
      for (const ref of refs) {
        if (!keys.has(ref)) badRefs.push(`${f.key} -> ${ref}`);
      }
    }
    expect(badRefs).toEqual([]);

    function reaches(start: string, target: string, seen = new Set<string>()): boolean {
      if (seen.has(start)) return false;
      seen.add(start);
      const row = byKey.get(start);
      if (!row?.requires) return false;
      const next = [...(row.requires.allOf ?? []), ...(row.requires.anyOf ?? [])];
      if (next.includes(target)) return true;
      return next.some((n) => reaches(n, target, seen));
    }
    const cycles = FEATURE_REGISTRY.filter((f) => reaches(f.key, f.key)).map((f) => f.key);
    expect(cycles).toEqual([]);
  });

  it("config.fallbackMode is always a real key in config.modes", () => {
    const bad = FEATURE_REGISTRY.filter(
      (f) => f.config && !(f.config.fallbackMode in f.config.modes),
    ).map((f) => f.key);
    expect(bad).toEqual([]);
  });

  it("config mode requires.allOf references real FEATURE_REGISTRY keys", () => {
    const keys = new Set(FEATURE_REGISTRY.map((f) => f.key));
    const badRefs: string[] = [];
    for (const f of FEATURE_REGISTRY) {
      for (const [modeName, mode] of Object.entries(f.config?.modes ?? {})) {
        for (const ref of mode.requires?.allOf ?? []) {
          if (!keys.has(ref)) badRefs.push(`${f.key}.config.modes.${modeName} -> ${ref}`);
        }
      }
    }
    expect(badRefs).toEqual([]);
  });

  it("orders_inline_returns is deliberately excluded (no call site yet)", () => {
    expect(byKey.has("orders_inline_returns")).toBe(false);
  });
});

// Type-only assertion: keeps this file failing to compile if FeatureDef's shape changes without
// the spec being revisited.
type _AssertFeatureDefShape = FeatureDef;
