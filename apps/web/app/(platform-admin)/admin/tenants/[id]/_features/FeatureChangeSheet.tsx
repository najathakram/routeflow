"use client";

import * as React from "react";
import type {
  FeatureChangeInput,
  FeatureChangePreviewRow,
  FeatureChangesApplyResponse,
  FeatureChangeState,
} from "@routeflow/types";
import {
  applyFeatureChanges,
  featureChangeMessage,
  isInputsChanged,
  previewFeatureChanges,
} from "@/lib/platform-admin/feature-changes";
import { AdminModal } from "../../../../_components/AdminModal";
import { changeCountLabel } from "./useFeatureStage";

export const CHANGED_BY_SOMEONE_ELSE = "Changed by someone else. Nothing was saved.";
export const NOT_CHECKED = "Not checked. These changes can't be saved until they are checked.";

const REASON_MIN = 3;
const FIELD =
  "mt-1 w-full rounded-lg bg-slate-900 px-3 py-2 text-sm text-white ring-1 ring-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";
const PRIMARY =
  "rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";
const SECONDARY =
  "rounded-lg px-4 py-2 text-sm font-semibold text-slate-200 ring-1 ring-slate-500 hover:bg-slate-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400";

/** "On", "Off" or "Plan default": what a feature is set to, in the words a person uses. */
export function stateWords(s: FeatureChangeState | null): string {
  if (!s) return "Plan default";
  return s.effect === "GRANT" ? "On" : "Off";
}

/** One line for a row of the sheet: "Sales agents: Plan default to On". */
export function changeSentence(label: string, row: FeatureChangePreviewRow): string {
  return `${label}: ${stateWords(row.before)} to ${stateWords(row.after)}`;
}

/** The last moment of the chosen day, so "ends 30 June" holds through the 30th. */
export function endOfDayIso(day: string): string {
  return new Date(`${day}T23:59:59.000`).toISOString();
}

type Checked =
  | { status: "checking" }
  | { status: "failed" }
  | { status: "stale" }
  | { status: "ready"; rows: FeatureChangePreviewRow[] };

export interface FeatureChangeSheetProps {
  open: boolean;
  tenantId: string;
  /** The hash read before the first change was staged. */
  expected: string;
  changes: FeatureChangeInput[];
  labelOf: (key: string) => string;
  onClose: () => void;
  /** The save went through: the stage is cleared and the toast offers Undo. */
  onSaved: (result: FeatureChangesApplyResponse, savedCount: number) => void;
  /** The business changed under the stage: reload what the page shows; the stage stays. */
  onStale: () => void;
  /** Review text for a Restore, in place of the reason box. */
  title?: string;
  initialReason?: string;
}

export function FeatureChangeSheet({
  open,
  tenantId,
  expected,
  changes,
  labelOf,
  onClose,
  onSaved,
  onStale,
  title = "Review changes",
  initialReason = "",
}: FeatureChangeSheetProps) {
  const [checked, setChecked] = React.useState<Checked>({ status: "checking" });
  const [reason, setReason] = React.useState(initialReason);
  const [endDate, setEndDate] = React.useState("");
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [attempt, setAttempt] = React.useState(0);

  const withEnd = React.useMemo<FeatureChangeInput[]>(
    () =>
      changes.map((c) =>
        c.action !== "CLEAR" && endDate ? { ...c, expiresAt: endOfDayIso(endDate) } : c,
      ),
    [changes, endDate],
  );

  // Check the set when the sheet opens (and on Retry, and when the end date moves): writes nothing.
  React.useEffect(() => {
    if (!open) return;
    let live = true;
    setChecked({ status: "checking" });
    previewFeatureChanges(tenantId, { expected, reason: "Preview", changes: withEnd })
      .then((r) => {
        if (!live) return;
        setChecked(r.stale ? { status: "stale" } : { status: "ready", rows: r.changes });
      })
      .catch((e) => {
        if (!live) return;
        if (isInputsChanged(e)) setChecked({ status: "stale" });
        else setChecked({ status: "failed" });
      });
    return () => {
      live = false;
    };
  }, [open, tenantId, expected, withEnd, attempt]);

  const rows = checked.status === "ready" ? checked.rows : [];
  const changing = rows.filter((r) => !r.unchanged);
  const staying = rows.filter((r) => r.unchanged);
  const reasonOk = reason.trim().length >= REASON_MIN;
  const canSave = checked.status === "ready" && changing.length > 0 && reasonOk && !saving;
  const hasEnd = withEnd.some((c) => c.expiresAt);

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const result = await applyFeatureChanges(tenantId, {
        expected,
        reason: reason.trim(),
        changes: withEnd,
      });
      onSaved(result, changing.length);
    } catch (e) {
      if (isInputsChanged(e)) {
        setChecked({ status: "stale" });
      } else {
        setError(featureChangeMessage(e, "Couldn't save. Nothing was changed."));
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <AdminModal
      open={open}
      onClose={onClose}
      title={title}
      sheet
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={onClose} className={SECONDARY}>
            Cancel
          </button>
          {checked.status === "failed" && (
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className={SECONDARY}>
              Retry
            </button>
          )}
          <button type="button" onClick={save} disabled={!canSave} className={PRIMARY}>
            {saving
              ? "Saving…"
              : changing.length > 0
                ? `Save ${changeCountLabel(changing.length)}`
                : "Save"}
          </button>
        </div>
      }
    >
      <div className="space-y-4 text-sm text-slate-200">
        {checked.status === "checking" && <p role="status">Checking these changes…</p>}
        {checked.status === "failed" && (
          <p role="alert" className="text-amber-300">
            {NOT_CHECKED}
          </p>
        )}
        {checked.status === "stale" && (
          <p role="alert" className="text-amber-300">
            {CHANGED_BY_SOMEONE_ELSE} Your staged changes are still here: reload, then review again.
          </p>
        )}
        {checked.status === "stale" && (
          <button type="button" onClick={onStale} className={SECONDARY}>
            Reload
          </button>
        )}

        {changing.length > 0 && (
          <section aria-labelledby="fc-now">
            <h3
              id="fc-now"
              className="text-xs font-semibold uppercase tracking-wide text-slate-400"
            >
              Changes now
            </h3>
            <ul className="mt-1 space-y-1">
              {changing.map((r) => (
                <li key={r.key}>{changeSentence(labelOf(r.key), r)}</li>
              ))}
            </ul>
          </section>
        )}
        {staying.length > 0 && (
          <section aria-labelledby="fc-stays">
            <h3
              id="fc-stays"
              className="text-xs font-semibold uppercase tracking-wide text-slate-400"
            >
              Stays on for now
            </h3>
            <ul className="mt-1 space-y-1 text-slate-300">
              {staying.map((r) => (
                <li key={r.key}>
                  {labelOf(r.key)}: already {stateWords(r.after).toLowerCase()}
                </li>
              ))}
            </ul>
          </section>
        )}

        {checked.status === "ready" && (
          <p className="text-slate-300">No charge. Overrides are never billed.</p>
        )}

        <div>
          <label htmlFor="fc-reason" className="block text-xs font-semibold text-slate-300">
            Why are you making these changes?
          </label>
          <textarea
            id="fc-reason"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
            className={FIELD}
          />
          {!reasonOk && reason.length > 0 && (
            <p className="mt-1 text-xs text-amber-300">Add a few words. History shows this.</p>
          )}
        </div>
        <div>
          <label htmlFor="fc-end" className="block text-xs font-semibold text-slate-300">
            End date (optional)
          </label>
          <input
            id="fc-end"
            type="date"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
            className={FIELD}
          />
          {hasEnd && (
            <p className="mt-1 text-xs text-slate-400">
              Applies to the features you turn on or off, not to the ones you clear.
            </p>
          )}
        </div>

        {error && (
          <p role="alert" className="text-red-300">
            {error}
          </p>
        )}
      </div>
    </AdminModal>
  );
}
