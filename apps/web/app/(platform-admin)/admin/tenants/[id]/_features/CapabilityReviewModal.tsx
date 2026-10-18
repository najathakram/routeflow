"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";
import {
  CapabilityPlanSections,
  billingStops,
  isEmptyPlan,
  type PlanSectionsSource,
} from "./CapabilityPlanSections";

/**
 * The create form's review of a plan that stops billing: "Change what this business does". The Setup tab reviews the
 * same plan inline (CapabilitiesCard); this dialog survives only where the plan arrives after the tenant is created
 * and the admin must still see, and confirm, what stops. The lines are the same sections the inline panel shows. It
 * never applies anything itself: `onConfirm` is the caller's one audited write. While `confirming` it cannot be
 * dismissed: the write is already in flight and Cancel would only hide it.
 */
export function CapabilityReviewModal({
  open,
  label,
  response,
  confirming,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** The ticked capabilities by name. */
  label: string;
  response: PlanSectionsSource | null;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}) {
  if (!open || !response) return null;

  const empty = isEmptyPlan(response);
  const stopsBilling = billingStops(response).length > 0;
  const handleClose = confirming ? () => {} : onClose;

  return (
    <AdminModal
      open
      onClose={handleClose}
      title="Change what this business does"
      footer={
        <>
          <button
            type="button"
            onClick={handleClose}
            disabled={confirming}
            className="min-h-[44px] rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={confirming || empty}
            className="min-h-[44px] rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {confirming ? "Applying..." : stopsBilling ? "Stop billing and apply" : "Apply"}
          </button>
        </>
      }
    >
      <p className="mb-3 text-sm font-medium text-slate-300">{label}</p>
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
          This business is already set up this way. Nothing will change.
        </p>
      ) : (
        <div className="max-h-[60vh] overflow-y-auto pr-1">
          <CapabilityPlanSections source={response} idPrefix="capability-review" />
        </div>
      )}
    </AdminModal>
  );
}
