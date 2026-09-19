import { groupPreview } from "./preview-groups";
import type { EffectiveFeature, FeaturePreviewResponse } from "./types";

function feature(key: string, over: Partial<EffectiveFeature> = {}): EffectiveFeature {
  return {
    key,
    area: "routes",
    serving: true,
    resolver: true,
    source: "PRESET",
    detail: { planKey: "PROFESSIONAL", catalogVersionId: "catalog-v11", enforced: false },
    billing: { charged: false },
    ...over,
  };
}

const mode = (effective: string): NonNullable<EffectiveFeature["mode"]> => ({
  value: effective,
  effective,
  source: "TENANT",
  allowed: ["manual", "scheduled"],
  blocked: [],
});

const LABELS = {
  recurring_routes: { label: "Recurring routes" },
  msrp: { label: "MSRP" },
  route_optimization: { label: "Route optimization" },
  sales_agents: { label: "Sales agents" },
};

describe("groupPreview", () => {
  it("returns empty groups for a null response", () => {
    expect(groupPreview(null, LABELS)).toEqual({
      gained: [],
      lost: [],
      limits: [],
      other: [],
      total: 0,
    });
  });

  it("buckets serving OFF→ON as gained and ON→OFF as lost, labelled from the registry", () => {
    const response: FeaturePreviewResponse = {
      before: [feature("msrp", { serving: false }), feature("recurring_routes")],
      after: [feature("msrp"), feature("recurring_routes", { serving: false })],
      changed: ["msrp", "recurring_routes"],
    };
    const g = groupPreview(response, LABELS);
    expect(g.gained.map((r) => r.label)).toEqual(["MSRP"]);
    expect(g.lost.map((r) => r.label)).toEqual(["Recurring routes"]);
    expect(g.limits).toEqual([]);
    expect(g.total).toBe(2);
  });

  it("a mode-only change (serving unchanged) is a limits change, even with an empty changed[]", () => {
    const response: FeaturePreviewResponse = {
      before: [feature("route_optimization", { mode: mode("manual") })],
      after: [feature("route_optimization", { mode: mode("scheduled") })],
      changed: [],
    };
    const g = groupPreview(response, LABELS);
    expect(g.limits.map((r) => r.key)).toEqual(["route_optimization"]);
    expect(g.gained).toEqual([]);
    expect(g.lost).toEqual([]);
  });

  it("a source-only change lands in 'other' instead of being dropped", () => {
    const response: FeaturePreviewResponse = {
      before: [feature("sales_agents", { source: "PRESET" })],
      after: [feature("sales_agents", { source: "ADDON_SKU" })],
      changed: ["sales_agents"],
    };
    const g = groupPreview(response, LABELS);
    expect(g.other.map((r) => r.key)).toEqual(["sales_agents"]);
    expect(g.total).toBe(1);
  });

  it("an identical before/after with a lying changed[] entry is 'other', not gained or lost", () => {
    const same = feature("msrp");
    const g = groupPreview({ before: [same], after: [same], changed: ["msrp"] }, LABELS);
    expect(g.gained).toEqual([]);
    expect(g.lost).toEqual([]);
  });

  it("identical before/after and empty changed[] is no change at all", () => {
    const same = feature("msrp");
    expect(groupPreview({ before: [same], after: [same], changed: [] }, LABELS).total).toBe(0);
  });

  it("falls back to the raw key when the registry has no label, and sorts each group by label", () => {
    const response: FeaturePreviewResponse = {
      before: [feature("zzz_unknown", { serving: false }), feature("msrp", { serving: false })],
      after: [feature("zzz_unknown"), feature("msrp")],
      changed: ["zzz_unknown", "msrp"],
    };
    expect(groupPreview(response, LABELS).gained.map((r) => r.label)).toEqual([
      "MSRP",
      "zzz_unknown",
    ]);
  });
});
