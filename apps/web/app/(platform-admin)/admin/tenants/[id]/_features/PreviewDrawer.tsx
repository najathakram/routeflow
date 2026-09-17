"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";
import { BADGE_COLORS, BADGE_LABELS, deriveBadge } from "./badge";
import type { EffectiveFeature, FeaturePreviewResponse } from "./types";

/** Only `label` is read — accepts either the full `FeatureRegistryRow` or the lighter
 * `FeatureRegistryOption` shape #795's overrides form already fetches. */
type RegistryLabelLookup = Record<string, { label: string }>;

/**
 * Shared preview → confirm UI for all three write paths (tier, override, mode) — brief D
 * item 3: "Every write = preview → confirm → apply". Never applies anything itself: `onConfirm`
 * is the caller's actual write (existing plan-change action / #795's override endpoints / brief
 * C's mode endpoint); `onClose` (Cancel or the X) calls nothing.
 */
export function PreviewDrawer({
  open,
  title,
  response,
  registryByKey,
  confirming,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  response: FeaturePreviewResponse | null;
  registryByKey: RegistryLabelLookup;
  confirming: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  const beforeByKey = new Map(response?.before.map((f) => [f.key, f]));
  const afterByKey = new Map(response?.after.map((f) => [f.key, f]));
  const changed = response?.changed ?? [];

  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={confirming || changed.length === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {confirming ? "Applying..." : "Confirm"}
          </button>
        </>
      }
    >
      {error && (
        <div className="mb-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30">
          {error}
        </div>
      )}
      {changed.length === 0 ? (
        <p className="text-sm text-slate-400">This change makes no difference for this tenant.</p>
      ) : (
        <ul data-testid="preview-diff" className="flex flex-col gap-3">
          {changed.map((key) => {
            const before = beforeByKey.get(key);
            const after = afterByKey.get(key) as EffectiveFeature | undefined;
            const label = registryByKey[key]?.label ?? key;
            return (
              <li key={key} className="rounded-lg bg-slate-900/40 p-3 ring-1 ring-white/5">
                <p className="text-sm font-medium text-white">{label}</p>
                <p className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                  <StateChip on={before?.serving} />
                  <span aria-hidden>→</span>
                  <StateChip on={after?.serving} />
                  {after && (
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${BADGE_COLORS[deriveBadge(after)]}`}
                    >
                      {BADGE_LABELS[deriveBadge(after)]}
                    </span>
                  )}
                  {after?.mode &&
                    before?.mode &&
                    after.mode.effective !== before.mode.effective && (
                      <span className="text-slate-500">
                        mode: {before.mode.effective} → {after.mode.effective}
                      </span>
                    )}
                </p>
                {after?.billing.charged && !before?.billing.charged && (
                  <p className="mt-1 text-xs text-amber-400">This will add a billed line item.</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </AdminModal>
  );
}

function StateChip({ on }: { on?: boolean }) {
  return <span className={on ? "text-emerald-400" : "text-slate-500"}>{on ? "On" : "Off"}</span>;
}
