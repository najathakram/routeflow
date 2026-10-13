"use client";

import * as React from "react";
import type { BusinessProfilePreviewResponse } from "@routeflow/types";
import { AdminModal } from "../../../../_components/AdminModal";
import { INCLUDED_FREE_COPY } from "./profile-plain-copy";
import { keyLabel } from "./setup-copy";

/**
 * Preview → confirm for one business profile. Billing is built from `plan.billing` (never by slicing `summary`): a
 * Stripe-billed module stops billing on confirm; a MANUALLY billed one must be taken off their manual invoice by hand,
 * and says so. SA-769: a module the profile will comp (`plan.comps`) is listed on its own with "Included free with this
 * profile" (copy from profile-plain-copy.ts); a comp row switched off (`plan.billing[].comp`) has no billing to stop,
 * so it is a plain change line, never a Billing claim. "What will change" is the API's own plain-English `changes`
 * list. It never applies anything
 * itself — `onConfirm` is the caller's one audited write. While `confirming` the dialog cannot be dismissed: the write
 * is already in flight and Cancel would only hide it.
 */
export function BusinessProfilePreviewModal({
  open,
  profileLabel,
  response,
  confirming,
  refreshing = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  profileLabel: string;
  response: BusinessProfilePreviewResponse | null;
  confirming: boolean;
  /** The preview is being fetched again (a stale plan): Confirm waits for the fresh one. */
  refreshing?: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open || !response) return null;

  const allBilling = response.plan?.billing ?? [];
  const billing = allBilling.filter((b) => !b.comp);
  const compsOff = allBilling.filter((b) => b.comp);
  const stopsBilling = billing.filter((b) => !b.manual);
  const manualBilling = billing.filter((b) => b.manual);
  const comps = response.plan?.comps ?? [];
  const changeLines = response.changes ?? [];
  const empty = allBilling.length === 0 && comps.length === 0 && changeLines.length === 0;
  const busy = confirming || refreshing;
  const handleClose = busy ? () => {} : onClose;

  return (
    <AdminModal
      open
      onClose={handleClose}
      title="Apply business profile"
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={busy}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy || empty}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : confirming ? "Applying..." : "Confirm"}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm font-medium text-slate-300">{profileLabel}</p>
      {error && (
        <div
          role="alert"
          className="mb-3 rounded-lg bg-red-900/30 px-4 py-3 text-sm text-red-300 ring-1 ring-red-600/30"
        >
          {error}
        </div>
      )}
      {empty ? (
        <p className="text-sm text-slate-400" data-testid="profile-preview-empty">
          This tenant already matches this profile. Nothing will change.
        </p>
      ) : (
        <div className="flex max-h-[60vh] flex-col gap-4 overflow-y-auto pr-1">
          {billing.length > 0 && (
            <section
              data-testid="profile-preview-billing"
              aria-labelledby="profile-preview-billing-title"
              className="rounded-lg bg-amber-900/20 p-3 ring-1 ring-amber-500/30"
            >
              <h4
                id="profile-preview-billing-title"
                className="text-sm font-semibold text-amber-300"
              >
                Billing
              </h4>
              {stopsBilling.length > 0 && (
                <div data-testid="profile-preview-billing-stops">
                  <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-slate-200">
                    {stopsBilling.map((b) => (
                      <li key={b.featureKey}>
                        {keyLabel(b.featureKey)} will be switched off and its billing stopped
                      </li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs text-amber-200">
                    Billing stops as soon as you confirm.
                  </p>
                </div>
              )}
              {manualBilling.length > 0 && (
                <div data-testid="profile-preview-billing-manual">
                  <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-slate-200">
                    {manualBilling.map((b) => (
                      <li key={b.featureKey}>{keyLabel(b.featureKey)} will be switched off</li>
                    ))}
                  </ul>
                  <p className="mt-2 text-xs font-semibold text-amber-200">
                    You must remove this from their manual invoice.
                  </p>
                </div>
              )}
            </section>
          )}
          {comps.length > 0 && (
            <section
              data-testid="profile-preview-comps"
              aria-labelledby="profile-preview-comps-title"
              className="rounded-lg bg-emerald-900/20 p-3 ring-1 ring-emerald-500/30"
            >
              <h4
                id="profile-preview-comps-title"
                className="text-sm font-semibold text-emerald-300"
              >
                Turned on for this business
              </h4>
              <ul className="mt-2 flex flex-col gap-1 text-sm text-slate-200">
                {comps.map((c) => (
                  <li key={c.featureKey} className="flex flex-wrap items-baseline gap-x-2">
                    <span>{keyLabel(c.featureKey)}</span>
                    <span className="text-xs font-medium text-emerald-300">
                      {INCLUDED_FREE_COPY}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
          {(changeLines.length > 0 || compsOff.length > 0) && (
            <section
              data-testid="profile-preview-changes"
              aria-labelledby="profile-preview-changes-title"
              className="rounded-lg bg-slate-900/40 p-3 ring-1 ring-white/10"
            >
              <h4
                id="profile-preview-changes-title"
                className="text-sm font-semibold text-slate-200"
              >
                What will change
              </h4>
              <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-sm text-slate-200">
                {compsOff.map((b) => (
                  <li key={`comp-off-${b.featureKey}`}>
                    {keyLabel(b.featureKey)} will be switched off (it was included free)
                  </li>
                ))}
                {changeLines.map((line, i) => (
                  <li key={`change-${i}`}>{line}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </AdminModal>
  );
}
