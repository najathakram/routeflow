import {
  FEATURE_BUSINESS_CATEGORY_VALUES,
  FEATURE_COMMERCIAL_CATEGORY_VALUES,
  FEATURE_PURPOSE_VALUES,
  FEATURE_RELEASE_STAGE_VALUES,
} from "@routeflow/types";
import { FEATURE_REGISTRY, featureDefByKey, type FeatureDef } from "./feature-registry";
import { toFeatureRegistryRow } from "./feature-registry-row";

/**
 * SA-950 piece A: every registry row says what KIND of choice it is (purpose + category), in plain
 * words (label, one-line description, keywords), and whether it works end to end (`incomplete`).
 * These are guards, not behaviour: piece A changes no gate, billing, default, requires, conflicts,
 * config or meter value. A row with no `nature` is a compile error; this spec pins the rest.
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const rows = FEATURE_REGISTRY;
const nature = (f: FeatureDef) => f.nature;

describe("FEATURE_REGISTRY nature (SA-950 A1)", () => {
  it("covers all 41 rows (a new row must be classified, not skipped)", () => {
    expect(rows).toHaveLength(41);
  });

  it("every row has a purpose from the shared list", () => {
    const bad = rows.filter((f) => !FEATURE_PURPOSE_VALUES.includes(nature(f).purpose));
    expect(bad.map((f) => f.key)).toEqual([]);
  });

  it("every business row has a business category and every commercial row a commercial one", () => {
    const bad = rows.filter((f) => {
      const n = nature(f);
      if (n.purpose === "business") return !FEATURE_BUSINESS_CATEGORY_VALUES.includes(n.category);
      if (n.purpose === "commercial") {
        return !FEATURE_COMMERCIAL_CATEGORY_VALUES.includes(n.category);
      }
      return "category" in n;
    });
    expect(bad.map((f) => f.key)).toEqual([]);
  });

  it("allowance applies exactly to the non-boolean rows (limit and metered)", () => {
    const wrong = rows.filter((f) => {
      const n = nature(f);
      const isAllowance = n.purpose === "commercial" && n.category === "allowance";
      return isAllowance !== (f.kind !== "boolean");
    });
    expect(wrong.map((f) => f.key)).toEqual([]);
    expect(rows.filter((f) => f.kind !== "boolean").map((f) => f.key)).toEqual([
      "ocr",
      "limit_seats",
      "limit_routes",
      "limit_customers",
      "metered_scans",
      "metered_msgs",
    ]);
  });

  it("purpose never encodes who pays: tobacco_dealer and the fleet add-ons are business rows", () => {
    for (const key of ["tobacco_dealer", "recurring_routes", "order_delivery", "driver_payments"]) {
      expect(featureDefByKey(key)?.nature.purpose).toBe("business");
    }
  });
});

describe("FEATURE_REGISTRY release block (SA-950 A2)", () => {
  const release = rows.filter((f) => f.nature.purpose === "release");

  it("every release row carries a valid block", () => {
    const now = new Date();
    const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    const bad: string[] = [];
    for (const f of release) {
      const n = f.nature;
      if (n.purpose !== "release") continue;
      const r = n.release;
      if (!FEATURE_RELEASE_STAGE_VALUES.includes(r.stage)) bad.push(`${f.key}:stage`);
      if (!DATE.test(r.introduced)) bad.push(`${f.key}:introduced`);
      if (!/^W-\d+$/.test(r.removalIssue)) bad.push(`${f.key}:removalIssue`);
      if (r.stage === "default") {
        if (!DATE.test(r.endDate)) bad.push(`${f.key}:endDate`);
      } else {
        // The existing `reviewBy` convention (dark gates): a date that has passed fails the build.
        const t = DATE.test(r.reviewBy) ? new Date(`${r.reviewBy}T00:00:00Z`).getTime() : NaN;
        if (!(t >= todayUtc)) bad.push(`${f.key}:reviewBy`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("per_tenant_legacy is exactly the three flag.units_* keys (count-pinned, shrink-only)", () => {
    const legacy = release
      .filter(
        (f) => f.nature.purpose === "release" && f.nature.release.stage === "per_tenant_legacy",
      )
      .map((f) => f.key)
      .sort();
    expect(legacy).toEqual(["flag.units_prices_v2", "flag.units_settings_v1", "flag.units_v1"]);
  });

  it("only release rows carry a release block", () => {
    const stray = rows.filter((f) => f.nature.purpose !== "release" && "release" in f.nature);
    expect(stray.map((f) => f.key)).toEqual([]);
  });
});

describe("FEATURE_REGISTRY plain words (SA-950 A4, A6, A7)", () => {
  it("every label and description is one clean line", () => {
    const bad = rows.filter(
      (f) =>
        f.label.trim() !== f.label ||
        f.label.length === 0 ||
        /[\r\n]/.test(f.label + f.description) ||
        f.description.trim() !== f.description ||
        f.description.length < 10 ||
        f.description.length > 140 ||
        !f.description.endsWith("."),
    );
    expect(bad.map((f) => f.key)).toEqual([]);
  });

  it("keywords are lower-case, trimmed, non-empty and unique within the row", () => {
    const bad = rows.filter((f) => {
      const k = f.keywords;
      return (
        k.some((w) => w.length === 0 || w !== w.trim() || w !== w.toLowerCase()) ||
        new Set(k).size !== k.length
      );
    });
    expect(bad.map((f) => f.key)).toEqual([]);
  });

  it("every business and commercial row has at least one keyword", () => {
    const bare = rows.filter((f) => f.nature.purpose !== "release" && f.keywords.length === 0);
    expect(bare.map((f) => f.key)).toEqual([]);
  });

  it("the PLAN's search examples resolve to the row that serves them", () => {
    const hits = (term: string) => rows.filter((f) => f.keywords.includes(term)).map((f) => f.key);
    expect(hits("pos")).toEqual(["counter_sales"]);
    expect(hits("till")).toEqual(["counter_sales"]);
    expect(hits("walk-in")).toEqual(["counter_sales"]);
    // "pickup" lands on fulfilment_model until piece C creates the Store pickup row.
    expect(hits("pickup")).toEqual(["fulfilment_model"]);
  });

  it("fulfilment_model and counter_sales keep their labels (SA-1 pin; piece C replaces them)", () => {
    expect(featureDefByKey("fulfilment_model")?.label).toBe("Where orders go");
    expect(featureDefByKey("counter_sales")?.label).toBe("Counter sales");
  });
});

describe("FEATURE_REGISTRY readiness (SA-950 A5)", () => {
  it("incomplete is set on exactly the four rows with no working feature", () => {
    const incomplete = rows.filter((f) => f.incomplete !== undefined).map((f) => f.key);
    expect(incomplete.sort()).toEqual([
      "flag.api_sso",
      "flag.dispatch_live",
      "flag.settlement",
      "mixed_packs",
    ]);
  });

  it("every incomplete.missing is one non-empty line", () => {
    const bad = rows.filter(
      (f) => f.incomplete !== undefined && !/^[^\r\n]{5,}$/.test(f.incomplete.missing),
    );
    expect(bad.map((f) => f.key)).toEqual([]);
  });
});

describe("GET features/registry wire row (SA-950 A3)", () => {
  it("carries purpose, category, keywords, incomplete and release.stage from the registry row", () => {
    for (const f of rows) {
      const wire = toFeatureRegistryRow(f);
      expect(wire.purpose).toBe(f.nature.purpose);
      expect(wire.keywords).toEqual(f.keywords);
      expect(wire.category).toBe(f.nature.purpose === "release" ? undefined : f.nature.category);
      expect(wire.incomplete).toEqual(f.incomplete);
      expect(wire.release?.stage).toBe(
        f.nature.purpose === "release" ? f.nature.release.stage : undefined,
      );
    }
  });

  it("keeps every pre-existing field exactly as the controller built it, for all rows", () => {
    // Verbatim copy of the mapping that lived in PlatformAdminController.listFeatureRegistry
    // before SA-950 A: the new fields are added, nothing else moves.
    const legacy = (f: FeatureDef) => ({
      key: f.key,
      kind: f.kind,
      area: f.area,
      label: f.label,
      description: f.description,
      lifecycle: f.gate.state === "dark" ? "beta" : "ga",
      internal: f.internal ?? false,
      gate: { via: f.gate.via, state: f.gate.state },
      billing: { skus: [...f.billing.skus] },
      ...(f.requires
        ? {
            requires: {
              ...(f.requires.allOf ? { allOf: [...f.requires.allOf] } : {}),
              ...(f.requires.anyOf ? { anyOf: [...f.requires.anyOf] } : {}),
            },
          }
        : {}),
      ...(f.config
        ? {
            config: {
              fallbackMode: f.config.fallbackMode,
              modes: Object.entries(f.config.modes).map(([key, m]) => ({
                key,
                label: m.label,
                lifecycle: "ga" as const,
                ...(m.requires?.allOf ? { requires: [...m.requires.allOf] } : {}),
              })),
            },
          }
        : {}),
    });
    for (const f of rows) {
      const {
        purpose: _purpose,
        category: _category,
        keywords: _keywords,
        incomplete: _incomplete,
        release: _release,
        ...rest
      } = toFeatureRegistryRow(f);
      expect(rest).toEqual(legacy(f));
    }
    expect(toFeatureRegistryRow(featureDefByKey("developer_mode")!).internal).toBe(true);
    expect(toFeatureRegistryRow(featureDefByKey("driver_payments")!).gate).toEqual({
      via: "guard",
      state: "enforced",
    });
  });

  it("omits release and incomplete from the JSON for rows that have neither", () => {
    const wire = JSON.parse(JSON.stringify(toFeatureRegistryRow(featureDefByKey("ocr")!)));
    expect(wire).not.toHaveProperty("release");
    expect(wire).not.toHaveProperty("incomplete");
  });
});
