"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";
import { BADGE_COLORS, BADGE_LABELS, deriveBadge } from "./badge";
import { groupPreview, type PreviewRow, type RegistryLabelLookup } from "./preview-groups";
import type { FeaturePreviewResponse } from "./types";

type PanelTone = "gain" | "loss" | "limit" | "other";

const PANELS: {
  id: "gained" | "lost" | "limits" | "other";
  tone: PanelTone;
  title: string;
  hint: string;
}[] = [
  { id: "gained", tone: "gain", title: "Gained", hint: "Turned on for this tenant" },
  { id: "lost", tone: "loss", title: "Lost", hint: "Turned off for this tenant" },
  {
    id: "limits",
    tone: "limit",
    title: "Limits changed",
    hint: "Stays on, configured differently",
  },
  { id: "other", tone: "other", title: "Other changes", hint: "Source or billing differs" },
];

const TONE_CLASSES: Record<PanelTone, { ring: string; dot: string; heading: string }> = {
  gain: { ring: "ring-emerald-500/25", dot: "bg-emerald-400", heading: "text-emerald-300" },
  loss: { ring: "ring-red-500/25", dot: "bg-red-400", heading: "text-red-300" },
  limit: { ring: "ring-amber-500/25", dot: "bg-amber-400", heading: "text-amber-300" },
  other: { ring: "ring-white/10", dot: "bg-slate-400", heading: "text-slate-300" },
};

/**
 * Shared preview → confirm UI for all three write paths (tier, override, mode) — brief D
 * item 3: "Every write = preview → confirm → apply". Never applies anything itself: `onConfirm`
 * is the caller's actual write (existing plan-change action / #795's override endpoints / brief
 * C's mode endpoint); `onClose` (Cancel or the X) calls nothing.
 *
 * The diff is grouped into Gained / Lost / Limits changed (B539) so an operator sees at a glance
 * what a tier change adds and drops before confirming; a change that alters nothing shows the
 * "no difference" state and cannot be confirmed.
 */
export function PreviewDrawer({
  open,
  title,
  subtitle,
  response,
  registryByKey,
  confirming,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  /** e.g. "Starter → Professional" — shown under the title inside the body. */
  subtitle?: string;
  response: FeaturePreviewResponse | null;
  registryByKey: RegistryLabelLookup;
  confirming: boolean;
  error?: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open) return null;

  // Union with `response.changed`, never trust it alone — a mode-only diff (serving unchanged)
  // must still enable Confirm even if the server's `changed[]` only tracks serving/source flips.
  const groups = groupPreview(response, registryByKey);

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
            disabled={confirming || groups.total === 0}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {confirming ? "Applying..." : "Confirm"}
          </button>
        </>
      }
    >
      {subtitle && <p className="mb-3 text-sm font-medium text-slate-300">{subtitle}</p>}
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30"
        >
          {error}
        </div>
      )}
      {groups.total === 0 ? (
        <p className="text-sm text-slate-400">This change makes no difference for this tenant.</p>
      ) : (
        <div data-testid="preview-diff" className="flex flex-col gap-4">
          <p className="text-xs text-slate-400" data-testid="preview-summary">
            {[
              groups.gained.length > 0 && `${groups.gained.length} gained`,
              groups.lost.length > 0 && `${groups.lost.length} lost`,
              groups.limits.length > 0 && `${groups.limits.length} limit change`,
              groups.other.length > 0 && `${groups.other.length} other`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
          {PANELS.map((panel) => {
            const rows = groups[panel.id];
            if (rows.length === 0) return null;
            const tone = TONE_CLASSES[panel.tone];
            const headingId = `preview-panel-${panel.id}`;
            return (
              <section
                key={panel.id}
                aria-labelledby={headingId}
                data-testid={`preview-panel-${panel.id}`}
                className={`rounded-lg bg-slate-900/40 p-3 ring-1 ${tone.ring}`}
              >
                <h4
                  id={headingId}
                  className={`flex items-center gap-2 text-sm font-semibold ${tone.heading}`}
                >
                  <span aria-hidden className={`h-2 w-2 rounded-full ${tone.dot}`} />
                  {panel.title} ({rows.length})
                  <span className="text-xs font-normal text-slate-500">{panel.hint}</span>
                </h4>
                <ul className="mt-2 flex flex-col gap-2">
                  {rows.map((row) => (
                    <DiffRow key={row.key} row={row} />
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </AdminModal>
  );
}

function DiffRow({ row }: { row: PreviewRow }) {
  const { before, after } = row;
  return (
    <li className="rounded-md bg-slate-900/50 px-3 py-2">
      <p className="text-sm font-medium text-white">{row.label}</p>
      <p className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-400">
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
        {after?.mode && before?.mode && after.mode.effective !== before.mode.effective && (
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
}

function StateChip({ on }: { on?: boolean }) {
  // Text, not colour alone — "On"/"Off" are the accessible names.
  return <span className={on ? "text-emerald-400" : "text-slate-500"}>{on ? "On" : "Off"}</span>;
}
