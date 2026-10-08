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

const UNKNOWN_MODE = "a setting this screen does not recognise";

/** A mode key as the registry's own label; an unknown key is described, never printed raw. */
export function modeLabel(options: FeatureModeOption[], key: string): string {
  return options.find((o) => o.key === key)?.label ?? UNKNOWN_MODE;
}

/** Where the applied mode came from, in plain words (B1132). */
export function modeSourceLabel(mode: Pick<FeatureModeState, "source">): string {
  return mode.source === "TENANT" ? "Set for this business" : "Default (not set for this business)";
}

/**
 * Why a free configuration row (gate `none`: no plan flag or add-on decides it) reads the way it
 * does. The plan default is NOT the reason such a row is on, so the plan sentence never applies to
 * it (B1132): the stored mode, and its source, are.
 */
export function explainModeSentence(options: FeatureModeOption[], mode: FeatureModeState): string {
  const applied = modeLabel(options, mode.effective);
  const base =
    mode.source === "TENANT"
      ? `Set to "${applied}" for this business, for example by applying a business profile in Setup. The plan does not decide this setting.`
      : `Not set for this business, so it uses the default, "${applied}". The plan does not decide this setting.`;
  return mode.value !== mode.effective
    ? `${base} The saved value "${modeLabel(options, mode.value)}" is not in effect because what it needs is not turned on.`
    : base;
}
