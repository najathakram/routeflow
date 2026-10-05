"use client";

import * as React from "react";
import type { BusinessProfilePreviewResponse } from "@routeflow/types";
import { AdminModal } from "../../../../_components/AdminModal";
import { keyLabel } from "./setup-copy";

/**
 * Preview → confirm for one business profile. Billing is built from `plan.billing` (never by slicing `summary`): a
 * Stripe-billed module stops billing on confirm; a MANUALLY billed one must be taken off their manual invoice by hand,
 * and says so. "What will change" is the API's own plain-English `changes` list. It never applies anything
 * itself — `onConfirm` is the caller's one audited write. While `confirming` the dialog cannot be dismissed: the write
 * is already in flight and Cancel would only hide it.
 */
export function BusinessProfilePreviewModal({
  open,
  profileLabel,
  response,
  confirming,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  profileLabel: string;
  response: BusinessProfilePreviewResponse | null;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open || !response) return null;

  const billing = response.plan?.billing ?? [];
  const stopsBilling = billing.filter((b) => !b.manual);
  const manualBilling = billing.filter((b) => b.manual);
  const changeLines = response.changes ?? [];
  const empty = billing.length === 0 && changeLines.length === 0;
  const handleClose = confirming ? () => {} : onClose;

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
            disabled={confirming}
            className="rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming || empty}
            className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {confirming ? "Applying..." : "Confirm"}
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
          {changeLines.length > 0 && (
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
