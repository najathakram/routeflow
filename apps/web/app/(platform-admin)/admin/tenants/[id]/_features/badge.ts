import type { EffectiveFeature, FeatureBadge, FeatureRegistryRow } from "./types";

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
  off: "bg-slate-800 text-slate-400 ring-slate-700",
  unknown: "bg-amber-900/40 text-amber-300 ring-amber-600/30",
};

// ─── One state readout per console row (BO-12, SA-963) ──────────────────────────────────────
//
// The first rule that applies wins (the applied-mode case, rule 1, is decided by the console
// because it needs the row's `config`):
//   2. no effective data for the row (or the server could not tell)  -> "Not reported" (amber)
//   3. feature on, gate dark, source none or an override that removes it -> "On, not enforced yet"
//   4. otherwise "On" / "Off", with the source folded in as ONE chip in the owner's words (SA-963):
//      In plan / Add-on / Free until <date> / Set for this business / Off for this business, plus
//      "kept from an earlier plan". The Off badge is dropped. No price: Plan & billing owns it.
export type ReadoutKind = "not-reported" | "not-enforced" | "chip" | "on" | "off";

export interface StateReadout {
  kind: ReadoutKind;
  text: string;
  /** Only for kind "chip": the source badge whose colours the chip uses. */
  badge?: FeatureBadge;
  /** Only for the Add-on chip: the tenant tab that shows what it costs (the price is never copied here). */
  linkTab?: "billing";
}

/** "Nov 30, 2026" in UTC, so the date never shifts with the admin's time zone; null if unparseable. */
function endDateText(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return at.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

/** The ONE map of chip words per source badge, and whether the badge implies the feature is on. */
export const READOUT_CHIPS: Partial<
  Record<FeatureBadge, { text: (f: EffectiveFeature) => string; on: boolean; linkTab?: "billing" }>
> = {
  inherited: { text: () => "In plan", on: true },
  purchased: { text: () => "Add-on", on: true, linkTab: "billing" },
  added: {
    text: (f) => {
      const until = endDateText(f.detail?.expiresAt);
      return until ? `Free until ${until}` : "Set for this business";
    },
    on: true,
  },
  removed: { text: () => "Off for this business", on: false },
  grandfathered: { text: () => "On, kept from an earlier plan", on: true },
};

export function deriveReadout(
  gate: Pick<FeatureRegistryRow["gate"], "state">,
  feature: EffectiveFeature | undefined,
): StateReadout {
  if (!feature || feature.source === "UNKNOWN") {
    return { kind: "not-reported", text: "Not reported" };
  }
  if (
    feature.serving &&
    gate.state === "dark" &&
    (feature.source === "NONE" || feature.source === "OVERRIDE_DENY")
  ) {
    return { kind: "not-enforced", text: "On, not enforced yet" };
  }
  const badge = deriveBadge(feature);
  const chip = READOUT_CHIPS[badge];
  // A source that contradicts what the row is actually serving (shadow mode) never gets a chip
  // that claims otherwise; the Details panel carries the resolver note.
  if (chip && chip.on === feature.serving) {
    return {
      kind: "chip",
      text: chip.text(feature),
      badge,
      ...(chip.linkTab ? { linkTab: chip.linkTab } : {}),
    };
  }
  return feature.serving ? { kind: "on", text: "On" } : { kind: "off", text: "Off" };
}
