"use client";

import * as React from "react";
import type {
  ConfigSnapshotHeld,
  ConfigSnapshotListItem,
  ConfigSnapshotPreview,
  ConfigSnapshotRestoreResult,
  ConfigSnapshotSkipReason,
} from "@routeflow/types";
import { fetchFeatureRegistry } from "@/lib/platform-admin/features";
import {
  fetchConfigSnapshots,
  previewConfigSnapshotRestore,
  restoreConfigSnapshot,
} from "@/lib/platform-admin/config-snapshots";
import { AdminCard } from "../../../../_components/AdminCard";
import { AdminModal } from "../../../../_components/AdminModal";

const SKIP_REASON_LABELS: Record<ConfigSnapshotSkipReason, string> = {
  UNKNOWN_FEATURE: "Feature no longer exists",
  MODE_NOT_OFFERED: "Mode no longer offered",
  EXPIRED: "Grant has expired",
  PLAN_NOT_ALLOWED: "Current plan does not include it",
  // BO-13 compile-only labels (P-WEB owns the final wording): the row is held, the snapshot stays restorable.
  CARRIER_IN_TRANSIT: "Orders are with the carrier",
  FULFILMENT_MODE_NEEDS_FLEET: "Own delivery needs a fleet module",
  // Row 640: a restored grant that nothing pays for, or whose prerequisite is missing.
  ADDON_NOT_PAID:
    "Add-on isn't paid for or included in the plan. Restore again once the add-on is billed.",
  REQUIRES_UNMET: "A required feature is missing",
};

/** The display name of a held row's setting (BO-13 holds `fulfilment_model` only today). */
const HELD_FEATURE_LABELS: Record<string, string> = { fulfilment_model: "Delivery model" };

/** Why a row is held, to follow "held while". */
const HELD_REASON_TEXT: Record<ConfigSnapshotHeld["reason"], string> = {
  CARRIER_IN_TRANSIT: "orders are with the carrier",
  FULFILMENT_MODE_NEEDS_FLEET: "own delivery needs a fleet module",
  ADDON_NOT_PAID:
    "the add-on isn't paid for or included in the plan; restore again once it is billed",
  REQUIRES_UNMET: "a required feature is missing",
};

const KIND_LABELS = { config: "Setting", override: "Grant/deny" } as const;

const fmt = (iso: string) => new Date(iso).toLocaleDateString();

function errorMessage(e: unknown, fallback: string): string {
  const status = (e as { response?: { status?: number } })?.response?.status;
  if (status === 409) return "This snapshot was already restored — the list has been refreshed.";
  if (status === 404) return "Snapshot not found.";
  if (status === 422) return "This snapshot's stored data is unreadable, so it cannot be restored.";
  return fallback;
}

function statusOf(s: ConfigSnapshotListItem): { label: string; tone: string } {
  if (!s.restoredAt) return { label: "Not restored", tone: "text-amber-300" };
  if (s.restoredToPlanKey === "SUPERSEDED") {
    return { label: "Superseded by a newer snapshot", tone: "text-slate-400" };
  }
  const r = s.restoreReport;
  const counts = r
    ? ` (${r.automatic ? "automatic" : "manual"}: ${r.restored} restored, ${r.keptNewer} kept, ${r.skipped} skipped)`
    : "";
  return {
    label: `Restored ${fmt(s.restoredAt)}${s.restoredToPlanKey ? ` → ${s.restoredToPlanKey}` : ""}${counts}`,
    tone: "text-green-400",
  };
}

/**
 * Tenant "Configuration snapshots" tab (Lane B A2 step c). A snapshot is taken when a plan
 * change downgrades the tenant (only while automatic archiving is on; the copy stays neutral); "Restore now" applies one as-was to the plan the tenant is
 * on today, after showing exactly what will be restored, kept and skipped (the preview is the same
 * plan a real restore runs). Restoring is a write, so it always goes through this preview → confirm.
 */
export function ConfigSnapshotsTab({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = React.useState<ConfigSnapshotListItem[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [target, setTarget] = React.useState<ConfigSnapshotListItem | null>(null);
  const [preview, setPreview] = React.useState<ConfigSnapshotPreview | null>(null);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState(false);
  // Registry labels for held keys (best effort: a failed read falls back to the raw key).
  const [labels, setLabels] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    fetchFeatureRegistry()
      .then((rows) => setLabels(Object.fromEntries(rows.map((r) => [r.key, r.label]))))
      .catch(() => undefined);
  }, []);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetchConfigSnapshots(tenantId)
      .then(setRows)
      .catch(() => setError("Failed to load configuration snapshots."))
      .finally(() => setLoading(false));
  }, [tenantId]);

  React.useEffect(load, [load]);

  function openRestore(row: ConfigSnapshotListItem) {
    setTarget(row);
    setPreview(null);
    setPreviewError(null);
    previewConfigSnapshotRestore(tenantId, row.id)
      .then(setPreview)
      .catch((e) => setPreviewError(errorMessage(e, "Failed to load the restore preview.")));
  }

  function closeRestore() {
    setTarget(null);
    setPreview(null);
    setPreviewError(null);
  }

  async function confirmRestore() {
    if (!target) return;
    setRestoring(true);
    try {
      const res: ConfigSnapshotRestoreResult = await restoreConfigSnapshot(tenantId, target.id);
      const report =
        `${res.report.restored} restored, ` +
        `${res.report.keptNewer} kept (changed since), ${res.report.skipped} skipped.`;
      // BO-13: a held row was NOT restored (and the snapshot stays restorable); say which and why.
      const held = res.held ?? [];
      setNotice(
        held.length === 0
          ? `Restored the ${fmt(res.takenAt)} snapshot: ${report}`
          : `Restored, except ${held
              .map(
                (h) =>
                  `${HELD_FEATURE_LABELS[h.featureKey] ?? labels[h.featureKey] ?? h.featureKey}: held while ${HELD_REASON_TEXT[h.reason]}`,
              )
              .join("; ")}. The ${fmt(res.takenAt)} snapshot: ${report}`,
      );
      closeRestore();
      load();
    } catch (e) {
      setPreviewError(errorMessage(e, "Restore failed — nothing was changed."));
      if ((e as { response?: { status?: number } })?.response?.status === 409) load();
    } finally {
      setRestoring(false);
    }
  }

  const nothingToRestore = !!preview && preview.willRestore.length === 0;

  return (
    <AdminCard title="Configuration snapshots" noPadding>
      <p className="border-b border-slate-700 px-5 py-3 text-xs text-slate-400">
        Archived when a plan change downgrades this tenant, once automatic archiving is switched on
        for the platform. Nothing is deleted on a downgrade — settings and grants stay but stop
        being honoured. Restore puts a snapshot back as it was, on the plan the tenant is on today.
      </p>
      {notice && (
        <p
          role="status"
          className="border-b border-slate-700 bg-green-900/20 px-5 py-3 text-xs text-green-300"
        >
          {notice}
        </p>
      )}
      {loading && <p className="px-5 py-10 text-center text-sm text-slate-400">Loading…</p>}
      {error && !loading && (
        <p role="alert" className="px-5 py-10 text-center text-sm text-red-400">
          {error}
        </p>
      )}
      {!loading && !error && (
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="Configuration snapshots"
          tabIndex={0}
        >
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-700 text-xs uppercase tracking-wider text-slate-400">
                <th className="px-4 py-3 text-left">Taken</th>
                <th className="px-4 py-3 text-left">Plan left</th>
                <th className="px-4 py-3 text-left">Reason</th>
                <th className="px-4 py-3 text-left">Entries</th>
                <th className="px-4 py-3 text-left">Status</th>
                <th className="px-4 py-3 text-right">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-700/50">
              {rows.map((r) => {
                const st = statusOf(r);
                return (
                  <tr key={r.id} className="hover:bg-slate-700/20">
                    <td className="px-4 py-2 text-slate-300">
                      {fmt(r.takenAt)}
                      <span className="text-slate-400"> · {r.ageDays}d ago</span>
                    </td>
                    <td className="px-4 py-2 text-slate-300">{r.planKey}</td>
                    <td className="px-4 py-2 text-slate-400">
                      {r.reason === "DOWNGRADE" ? "Downgrade" : "Manual"}
                      {r.createdByName ? ` · ${r.createdByName}` : ""}
                    </td>
                    <td className="px-4 py-2 text-slate-400">
                      {r.entries
                        ? `${r.entries.configs} settings, ${r.entries.overrides} grants`
                        : "Unreadable"}
                    </td>
                    <td className={`px-4 py-2 ${st.tone}`}>{st.label}</td>
                    <td className="px-4 py-2 text-right">
                      {!r.restoredAt && r.entries && (
                        <button
                          onClick={() => openRestore(r)}
                          aria-label={`Restore now — snapshot of ${fmt(r.takenAt)} (${r.planKey})`}
                          className="min-h-[36px] rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-indigo-500"
                        >
                          Restore now
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr>
                  <td colSpan={6} className="px-4 py-10 text-center text-slate-400">
                    No snapshots yet — one is taken the first time this tenant is downgraded.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <AdminModal
        open={!!target}
        onClose={closeRestore}
        title="Restore configuration snapshot"
        footer={
          <>
            <button
              onClick={closeRestore}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              onClick={confirmRestore}
              disabled={!preview || nothingToRestore || restoring}
              aria-describedby={nothingToRestore ? "restore-nothing-hint" : undefined}
              className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {restoring ? "Restoring…" : "Restore now"}
            </button>
          </>
        }
      >
        {previewError && (
          <p role="alert" className="mb-3 text-xs text-red-400">
            {previewError}
          </p>
        )}
        {!preview && !previewError && <p className="text-sm text-slate-400">Loading preview…</p>}
        {preview && (
          <div className="flex flex-col gap-4 text-xs">
            <p className="text-slate-300">
              Snapshot of {fmt(preview.takenAt)} ({preview.ageDays}{" "}
              {preview.ageDays === 1 ? "day" : "days"} old, taken leaving {preview.planKey}),
              restored as it was onto the tenant&apos;s current plan,{" "}
              <b>{preview.currentPlanKey}</b>.
            </p>
            {preview.beyondAutoRestoreHorizon && (
              <p role="status" className="rounded-lg bg-amber-900/30 px-3 py-2 text-amber-200">
                This snapshot is older than {preview.autoRestoreMaxAgeDays} days, so an automatic
                restore would not have applied it. You are restoring it deliberately — check the
                list below before confirming.
              </p>
            )}
            <PreviewSection title={`Will be restored (${preview.willRestore.length})`}>
              {preview.willRestore.length === 0 ? (
                <li id="restore-nothing-hint" className="text-slate-400">
                  Nothing to restore — everything is already in place or skipped.
                </li>
              ) : (
                preview.willRestore.map((e) => (
                  <li key={`${e.kind}:${e.featureKey}`}>
                    <span className="font-mono text-slate-200">{e.featureKey}</span>{" "}
                    <span className="text-slate-400">· {KIND_LABELS[e.kind]}</span>
                  </li>
                ))
              )}
            </PreviewSection>
            {preview.keptNewer.length > 0 && (
              <PreviewSection
                title={`Kept — changed since the snapshot (${preview.keptNewer.length})`}
              >
                {preview.keptNewer.map((k) => (
                  <li key={k} className="font-mono text-slate-200">
                    {k}
                  </li>
                ))}
              </PreviewSection>
            )}
            {preview.skipped.length > 0 && (
              <PreviewSection title={`Skipped (${preview.skipped.length})`}>
                {preview.skipped.map((s) => (
                  <li key={`${s.kind}:${s.featureKey}`}>
                    <span className="font-mono text-slate-200">{s.featureKey}</span>{" "}
                    <span className="text-slate-400">· {SKIP_REASON_LABELS[s.reason]}</span>
                  </li>
                ))}
              </PreviewSection>
            )}
            {preview.unchangedCount > 0 && (
              <p className="text-slate-400">{preview.unchangedCount} already match — no change.</p>
            )}
          </div>
        )}
      </AdminModal>
    </AdminCard>
  );
}

function PreviewSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h4 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {title}
      </h4>
      <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">{children}</ul>
    </section>
  );
}
