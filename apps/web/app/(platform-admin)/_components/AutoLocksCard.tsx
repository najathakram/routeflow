"use client";

import * as React from "react";
import { PauseCircle, PlayCircle } from "lucide-react";
import type { AutoLockPreview, AutoLockState, SetAutoLockPausedRequest } from "@routeflow/types";
import { superAdminClient } from "@/lib/admin-api";
import {
  AUTO_LOCK_COPY,
  REASON_MAX,
  autoLockBanner,
  isReasonValid,
  kindLabel,
  unpauseConfirmCopy,
  wouldLockRowText,
} from "@/lib/platform-admin/auto-locks";
import { AdminCard } from "./AdminCard";
import { AdminModal } from "./AdminModal";

const BASE = "/platform-admin/config/auto-locks";
const BTN =
  "rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50";

/** The tenants an unpause (or the current pause) concerns, by id and kind only. */
function TenantList({ rows, label }: { rows: AutoLockState["wouldLockNow"]; label: string }) {
  if (rows.length === 0) return null;
  return (
    <ul
      aria-label={label}
      className="mt-3 max-h-48 divide-y divide-slate-700 overflow-y-auto rounded-lg bg-slate-900/60 ring-1 ring-white/5"
    >
      {rows.map((r) => (
        <li
          key={`${r.tenantId}:${r.kind}:${r.key}`}
          className="px-3 py-2 font-mono text-xs text-slate-300"
        >
          {wouldLockRowText(r)}
        </li>
      ))}
    </ul>
  );
}

/**
 * SA-775 (row 381): the super-admin switch for AUTOMATIC tenant locks. Pausing needs a reason and one click;
 * UNPAUSING first loads the read-only preview and shows "Unpausing will lock these N tenants within the hour",
 * and flips the switch only on an explicit confirm. The switch never unlocks anyone.
 */
export function AutoLocksCard() {
  const [state, setState] = React.useState<AutoLockState | null>(null);
  const [loadError, setLoadError] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [preview, setPreview] = React.useState<AutoLockPreview | null>(null);
  const [previewFailed, setPreviewFailed] = React.useState(false);
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const reasonId = React.useId();

  const load = React.useCallback(async () => {
    try {
      const res = await superAdminClient.get<AutoLockState>(BASE);
      setState(res.data);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  React.useEffect(() => {
    if (confirmOpen) cancelRef.current?.focus();
  }, [confirmOpen, preview, previewFailed]);

  const send = async (paused: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const body: SetAutoLockPausedRequest = { paused, reason: reason.trim() };
      await superAdminClient.patch(BASE, body);
      setReason("");
      setConfirmOpen(false);
      await load();
    } catch {
      setError(AUTO_LOCK_COPY.switchFailed);
    } finally {
      setBusy(false);
    }
  };

  const openUnpause = async () => {
    setError(null);
    setPreview(null);
    setPreviewFailed(false);
    setConfirmOpen(true);
    try {
      const res = await superAdminClient.get<AutoLockPreview>(`${BASE}/preview`);
      setPreview(res.data);
    } catch {
      setPreviewFailed(true);
    }
  };

  const reasonOk = isReasonValid(reason);
  const paused = state?.paused ?? true;
  const copy = unpauseConfirmCopy(previewFailed ? null : preview);

  return (
    <AdminCard title="Automatic locks">
      {loadError && !state ? (
        <p role="alert" className="text-sm text-red-400">
          {AUTO_LOCK_COPY.loadFailed}
        </p>
      ) : !state ? (
        <p className="text-sm text-slate-400">Loading…</p>
      ) : (
        <>
          <div
            role="status"
            className={`flex items-start gap-3 rounded-lg px-4 py-3 text-sm ring-1 ${
              paused
                ? "bg-amber-900/30 text-amber-200 ring-amber-700/50"
                : "bg-emerald-900/30 text-emerald-200 ring-emerald-700/50"
            }`}
          >
            {paused ? (
              <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            ) : (
              <PlayCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            )}
            <div>
              <p className="font-medium">{autoLockBanner(state)}</p>
              <p className="mt-1 text-xs opacity-80">
                {paused ? AUTO_LOCK_COPY.pausedNow : AUTO_LOCK_COPY.unpausedNow}{" "}
                {AUTO_LOCK_COPY.neverUnlocks}
              </p>
              {state.reason && (
                <p className="mt-1 text-xs opacity-80">Last change: {state.reason}</p>
              )}
            </div>
          </div>

          {paused && (
            <TenantList rows={state.wouldLockNow} label="Tenants that would be locked now" />
          )}

          {state.skipped.length > 0 && (
            <details className="mt-3 text-xs text-slate-400">
              <summary className="cursor-pointer">
                {state.skipped.length} {state.skipped.length === 1 ? "lock" : "locks"} held so far
              </summary>
              <ul aria-label="Locks held so far" className="mt-2 space-y-1 font-mono">
                {state.skipped.map((s) => (
                  <li key={`${s.tenantId}:${s.kind}:${s.key}`}>
                    {s.tenantId} — {kindLabel(s.kind)} — {s.at.slice(0, 16).replace("T", " ")}Z
                  </li>
                ))}
              </ul>
            </details>
          )}

          <div className="mt-4">
            <label htmlFor={reasonId} className="block text-xs font-medium text-slate-400">
              Reason for the change (kept in the audit log)
            </label>
            <input
              id={reasonId}
              type="text"
              value={reason}
              maxLength={REASON_MAX}
              onChange={(e) => setReason(e.target.value)}
              className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-white focus:border-indigo-500 focus:outline-none"
            />
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {paused ? (
              <button
                type="button"
                onClick={openUnpause}
                disabled={busy || !reasonOk}
                className={`${BTN} bg-indigo-600 hover:bg-indigo-500`}
              >
                Unpause automatic locks…
              </button>
            ) : (
              <button
                type="button"
                onClick={() => send(true)}
                disabled={busy || !reasonOk}
                className={`${BTN} bg-amber-700 hover:bg-amber-600`}
              >
                Pause automatic locks
              </button>
            )}
            {!reasonOk && (
              <span className="text-xs text-slate-400">
                Add a reason (3 to {REASON_MAX} characters).
              </span>
            )}
          </div>
          {error && (
            <p role="alert" className="mt-3 text-sm text-red-400">
              {error}
            </p>
          )}
        </>
      )}

      <AdminModal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={copy.title}
        footer={
          <>
            <button
              ref={cancelRef}
              type="button"
              onClick={() => setConfirmOpen(false)}
              className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={busy || !preview || previewFailed || !reasonOk}
              onClick={() => send(false)}
              className={`${BTN} bg-indigo-600 hover:bg-indigo-500`}
            >
              {copy.confirmLabel}
            </button>
          </>
        }
      >
        {!preview && !previewFailed ? (
          <p className="text-sm text-slate-400">Loading the preview…</p>
        ) : previewFailed ? (
          <p role="alert" className="text-sm text-red-400">
            {AUTO_LOCK_COPY.previewFailed} {copy.body}
          </p>
        ) : (
          <>
            <p className="text-sm text-slate-300">{copy.body}</p>
            <TenantList rows={preview?.wouldLock ?? []} label="Tenants an unpause would lock" />
          </>
        )}
      </AdminModal>
    </AdminCard>
  );
}
