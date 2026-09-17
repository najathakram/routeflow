import type { EffectiveFeature, FeatureBadge } from "./types";

// design.md §2 Effective: source priority OVERRIDE_DENY → OVERRIDE_GRANT → ADDON_SKU →
// PRESET(term) → NONE maps to badge removed/added/purchased/grandfathered/inherited/off.
// "grandfathered" is not a distinct FeatureSource — it's an OVERRIDE_GRANT whose
// detail.kind is the FeatureOverrideKind "GRANDFATHER" (brief A schema §5).
export function deriveBadge(feature: Pick<EffectiveFeature, "source" | "detail">): FeatureBadge {
  switch (feature.source) {
    case "OVERRIDE_DENY":
      return "removed";
    case "OVERRIDE_GRANT":
      return feature.detail?.kind === "GRANDFATHER" ? "grandfathered" : "added";
    case "ADDON_SKU":
      return "purchased";
    case "PRESET":
      return "inherited";
    case "NONE":
      return "off";
    default:
      return "unknown";
  }
}

export const BADGE_LABELS: Record<FeatureBadge, string> = {
  inherited: "Inherited",
  added: "Added",
  removed: "Removed",
  grandfathered: "Grandfathered",
  purchased: "Purchased",
  off: "Off",
  unknown: "Unknown",
};

export const BADGE_COLORS: Record<FeatureBadge, string> = {
  inherited: "bg-slate-700 text-slate-300 ring-slate-600/30",
  added: "bg-emerald-900/40 text-emerald-300 ring-emerald-600/30",
  removed: "bg-red-900/40 text-red-300 ring-red-600/30",
  grandfathered: "bg-purple-900/40 text-purple-300 ring-purple-600/30",
  purchased: "bg-blue-900/40 text-blue-300 ring-blue-600/30",
  off: "bg-slate-800 text-slate-500 ring-slate-700",
  unknown: "bg-amber-900/40 text-amber-300 ring-amber-600/30",
};
