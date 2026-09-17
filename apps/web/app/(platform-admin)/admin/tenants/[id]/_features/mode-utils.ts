import type { FeatureModeOption, FeatureModeState } from "./types";

/**
 * design.md §2 Modes: `mode.effective = value` iff the key AND every `requires.allOf` key are
 * effective, else `fallbackMode` + `blocked:[]` — the blocked ARRAY names which mode *option
 * keys* are unavailable, not which prerequisite is missing. To show "the missing key" in an
 * option's disabled title, cross-reference that option's own `requires` list against the
 * tenant's effective feature-key set.
 */
export function blockedReason(
  option: FeatureModeOption,
  effectiveKeys: ReadonlySet<string>,
): string | null {
  if (!option.requires || option.requires.length === 0) {
    return "Not available for this tenant.";
  }
  const missing = option.requires.filter((k) => !effectiveKeys.has(k));
  if (missing.length === 0) return "Not available for this tenant.";
  return `Requires ${missing.join(", ")} — not enabled for this tenant.`;
}

export function isOptionBlocked(option: FeatureModeOption, mode: FeatureModeState): boolean {
  return mode.blocked.includes(option.key);
}

/** Selectable radio options: every configured mode except the synthetic "mixed" state. */
export function selectableOptions(options: FeatureModeOption[]): FeatureModeOption[] {
  return options.filter((o) => o.key !== "mixed");
}

export const MIXED_LABEL = "Both";
