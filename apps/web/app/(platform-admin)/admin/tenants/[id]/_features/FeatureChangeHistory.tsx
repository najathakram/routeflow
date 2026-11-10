"use client";

import * as React from "react";
import { API_ERROR_CODES, type FeatureChangeInput } from "@routeflow/types";
import { fetchFeatureRegistry } from "@/lib/platform-admin/features";
import {
  fetchFeatureChangeLog,
  fetchFeatureInputsHash,
  featureChangeErrorCode,
  undoFeatureChanges,
  type FeatureChangeLogRow,
} from "@/lib/platform-admin/feature-changes";
import { AdminCard } from "../../../../_components/AdminCard";
import { FeatureChangeSheet } from "./FeatureChangeSheet";
import { describeChangeSet, restoreInputs, undoableId } from "./feature-change-history";

const LINK =
  "min-h-[36px] rounded px-2 py-1 text-xs font-semibold text-indigo-300 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 disabled:opacity-50";

const NOT_UNDOABLE =
  "This change can't be undone any more because something changed after it. Use Restore instead.";

/**
 * History of saved feature changes (WP11, R48/R28/R50): one sentence per saved set, "Undo this change" while it can
 * still be undone, and Restore, which stages the earlier settings and goes through the same review sheet.
 */
export function FeatureChangeHistory({ tenantId }: { tenantId: string }) {
  const [rows, setRows] = React.useState<FeatureChangeLogRow[]>([]);
  const [labels, setLabels] = React.useState<Record<string, string>>({});
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState<string | null>(null);
  const [restoring, setRestoring] = React.useState<{
    row: FeatureChangeLogRow;
    expected: string;
    changes: FeatureChangeInput[];
  } | null>(null);

  const load = React.useCallback(() => {
    setLoading(true);
    setError(null);
    fetchFeatureChangeLog(tenantId)
      .then(setRows)
      .catch(() => setError("Couldn't load the feature changes."))
      .finally(() => setLoading(false));
  }, [tenantId]);

  React.useEffect(load, [load]);
  React.useEffect(() => {
    fetchFeatureRegistry()
      .then((reg) => setLabels(Object.fromEntries(reg.map((r) => [r.key, r.label]))))
      .catch(() => undefined);
  }, []);

  const labelOf = (key: string) => labels[key] ?? key;
  const undoId = undoableId(rows);

  async function undo(row: FeatureChangeLogRow) {
    setBusy(row.id);
    setNotice(null);
    setError(null);
    try {
      const res = await undoFeatureChanges(tenantId, row.id, "Undone from History.");
      setNotice(
        res?.skippedExpired?.length
          ? "Undone. Some earlier settings had already ended, so they were not put back."
          : "Undone. The earlier settings are back.",
      );
      load();
    } catch (e) {
      setError(
        featureChangeErrorCode(e) === API_ERROR_CODES.FEATURE_CHANGE_NOT_UNDOABLE
          ? NOT_UNDOABLE
          : "Couldn't undo. Nothing was changed.",
      );
    } finally {
      setBusy(null);
    }
  }

  async function startRestore(row: FeatureChangeLogRow) {
    setBusy(row.id);
    setNotice(null);
    setError(null);
    try {
      const expected = await fetchFeatureInputsHash(tenantId);
      setRestoring({ row, expected, changes: restoreInputs(row) });
    } catch {
      setError("Couldn't start the restore. Try again.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <AdminCard title="Feature changes" noPadding>
      {notice && (
        <p
          role="status"
          className="border-b border-slate-700 bg-green-900/20 px-5 py-3 text-xs text-green-300"
        >
          {notice}
        </p>
      )}
      {error && (
        <p role="alert" className="border-b border-slate-700 px-5 py-3 text-xs text-red-400">
          {error}
        </p>
      )}
      {loading && <p className="px-5 py-6 text-center text-sm text-slate-400">Loading…</p>}
      {!loading && rows.length === 0 && !error && (
        <p className="px-5 py-6 text-center text-sm text-slate-400">
          No saved feature changes yet.
        </p>
      )}
      {!loading && rows.length > 0 && (
        <ul className="divide-y divide-slate-700/50">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-col gap-1 px-5 py-3 text-sm text-slate-200 sm:flex-row sm:items-center sm:justify-between"
            >
              <div className="min-w-0">
                <p>{describeChangeSet(r, labelOf)}</p>
                <p className="text-xs text-slate-400">{new Date(r.createdAt).toLocaleString()}</p>
              </div>
              {r.action === "FEATURE_CHANGE_SET_APPLIED" && (
                <div className="flex shrink-0 items-center gap-1">
                  {r.id === undoId && (
                    <button
                      type="button"
                      className={LINK}
                      disabled={busy === r.id}
                      onClick={() => undo(r)}
                    >
                      {busy === r.id ? "Undoing…" : "Undo this change"}
                    </button>
                  )}
                  {restoreInputs(r).length > 0 && (
                    <button
                      type="button"
                      className={LINK}
                      disabled={busy === r.id}
                      onClick={() => startRestore(r)}
                    >
                      Restore the earlier settings
                    </button>
                  )}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {restoring && (
        <FeatureChangeSheet
          open
          title="Restore the earlier settings"
          tenantId={tenantId}
          expected={restoring.expected}
          changes={restoring.changes}
          labelOf={labelOf}
          initialReason={`Restored the settings from ${new Date(restoring.row.createdAt).toLocaleDateString()}.`}
          onClose={() => setRestoring(null)}
          onSaved={(_result, count) => {
            setRestoring(null);
            setNotice(`Restored. ${count} ${count === 1 ? "change" : "changes"} saved.`);
            load();
          }}
          onStale={() => {
            const row = restoring.row;
            setRestoring(null);
            void startRestore(row);
          }}
        />
      )}
    </AdminCard>
  );
}
