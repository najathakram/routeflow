"use client";

import * as React from "react";
import { ADDON_ROW_KEY_BY_REGISTRY_KEY } from "../../[id]/_features/FeatureConsole";

/** One free add-on the form can offer: the registry's own plain label and one-line description. */
export interface FreeAddon {
  /** The `addonKey` that `POST .../addons/enable` takes. */
  addonKey: string;
  label: string;
  description: string;
}

/** Only registry rows that can be provisioned as an add-on row (the Feature Console's own list), nothing else. */
export function freeAddonsFromRegistry(
  rows: ReadonlyArray<{ key: string; label: string; description: string }>,
): FreeAddon[] {
  const out: FreeAddon[] = [];
  for (const row of rows) {
    if (!Object.prototype.hasOwnProperty.call(ADDON_ROW_KEY_BY_REGISTRY_KEY, row.key)) continue;
    out.push({
      addonKey: ADDON_ROW_KEY_BY_REGISTRY_KEY[row.key]!,
      label: row.label,
      description: row.description,
    });
  }
  return out;
}

/**
 * Collapsed "Free add-ons (comped, never billed)": checkboxes for the add-ons that turn on as a comp after the
 * account exists. Billed add-ons are never offered here.
 */
export function FreeAddonsSection({
  addons,
  failed,
  selected,
  onToggle,
  disabled,
}: {
  addons: FreeAddon[] | null;
  failed: boolean;
  selected: ReadonlySet<string>;
  onToggle: (addonKey: string) => void;
  disabled?: boolean;
}) {
  return (
    <details className="rounded-lg bg-slate-900/40 ring-1 ring-white/10">
      <summary className="flex min-h-[44px] cursor-pointer items-center gap-2 px-3 text-sm font-medium text-slate-300">
        Free add-ons (comped, never billed)
        <span
          data-testid="addons-count"
          className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px] font-medium text-slate-300"
        >
          {selected.size}
        </span>
      </summary>
      <div className="flex flex-col gap-2 px-3 pb-3">
        <p className="text-xs text-slate-400">
          These turn on at no charge and never appear on an invoice. Billed add-ons are bought by
          the business at checkout.
        </p>
        {failed ? (
          <p className="text-xs text-amber-400">
            Free add-ons could not be loaded. You can turn them on later from the tenant&apos;s
            Setup tab.
          </p>
        ) : addons === null ? (
          <p className="text-xs text-slate-400">Loading add-ons…</p>
        ) : (
          <fieldset className="flex flex-col gap-1" disabled={disabled}>
            <legend className="sr-only">Free add-ons</legend>
            {addons.map((a) => (
              <label
                key={a.addonKey}
                className="flex min-h-[44px] items-start gap-3 py-1 text-sm text-slate-200"
              >
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={selected.has(a.addonKey)}
                  onChange={() => onToggle(a.addonKey)}
                />
                <span className="flex flex-col">
                  {a.label}
                  <span className="text-xs text-slate-400">{a.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
      </div>
    </details>
  );
}
