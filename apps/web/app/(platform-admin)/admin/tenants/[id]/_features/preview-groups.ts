import type { EffectiveFeature, FeaturePreviewResponse } from "./types";

/** Only `label` is required — the drawer accepts either the full `FeatureRegistryRow` or the lighter
 *  option shape the overrides form fetches. */
export type RegistryLabelLookup = Record<string, { label: string }>;

export interface PreviewRow {
  key: string;
  label: string;
  before?: EffectiveFeature;
  after?: EffectiveFeature;
}

export interface PreviewGroups {
  /** Serving OFF → ON: the tenant gains this feature. */
  gained: PreviewRow[];
  /** Serving ON → OFF: the tenant loses this feature. */
  lost: PreviewRow[];
  /** Serving unchanged but the configured mode differs (mode previews; a tier preview never
   *  carries modes, so this stays empty for a plan swap). */
  limits: PreviewRow[];
  /** Anything else that differs (source or billing changed, serving did not) — never dropped. */
  other: PreviewRow[];
  total: number;
}

/**
 * Buckets a `POST /platform-admin/tenants/:id/features/preview` response into what an operator
 * needs before confirming a change: what is GAINED, what is LOST, what CONFIGURATION changes.
 *
 * `response.changed` is only trusted as a floor — the diff is re-derived from before/after so a
 * mode-only change still counts even if the server's `changed[]` tracks only serving/source flips
 * (same rule `PreviewDrawer`'s Confirm enablement already follows).
 */
export function groupPreview(
  response: FeaturePreviewResponse | null,
  registryByKey: RegistryLabelLookup,
): PreviewGroups {
  const groups: PreviewGroups = { gained: [], lost: [], limits: [], other: [], total: 0 };
  if (!response) return groups;

  const beforeByKey = new Map(response.before.map((f) => [f.key, f]));
  const afterByKey = new Map(response.after.map((f) => [f.key, f]));
  const changedKeys = new Set(response.changed);
  for (const [key, after] of afterByKey) {
    const before = beforeByKey.get(key);
    if (!before) continue;
    if (before.serving !== after.serving) changedKeys.add(key);
    if (before.mode?.effective !== after.mode?.effective) changedKeys.add(key);
  }

  for (const key of changedKeys) {
    const before = beforeByKey.get(key);
    const after = afterByKey.get(key);
    const row: PreviewRow = { key, label: registryByKey[key]?.label ?? key, before, after };
    const wasOn = before?.serving ?? false;
    const isOn = after?.serving ?? false;
    if (!wasOn && isOn) groups.gained.push(row);
    else if (wasOn && !isOn) groups.lost.push(row);
    else if (before?.mode?.effective !== after?.mode?.effective) groups.limits.push(row);
    else groups.other.push(row);
  }

  const byLabel = (a: PreviewRow, b: PreviewRow) => a.label.localeCompare(b.label);
  for (const list of [groups.gained, groups.lost, groups.limits, groups.other]) list.sort(byLabel);
  groups.total =
    groups.gained.length + groups.lost.length + groups.limits.length + groups.other.length;
  return groups;
}
