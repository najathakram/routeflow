"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";
import { keyLabel } from "./setup-copy";

/**
 * The one confirm in the capabilities flow, and only when the change stops billing: "Stop billing for N add-ons?".
 * Each add-on is named with what happens to it: a Stripe-billed one stops billing now, a manually billed one must be
 * taken off their manual invoice by hand. Cancel takes the focus (the safe default); the destructive button is the
 * only way through. It never writes by itself: `onConfirm` is the caller's one audited write.
 */
export function CapabilityBillingDialog({
  open,
  rows,
  busy,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  rows: { featureKey: string; manual: boolean }[];
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  const listId = React.useId();
  const n = rows.length;
  return (
    <AdminModal
      open={open}
      role="alertdialog"
      onClose={busy ? () => {} : onCancel}
      title={`Stop billing for ${n} add-on${n === 1 ? "" : "s"}?`}
      initialFocusRef={cancelRef}
      describedBy={listId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="!min-h-[44px] rounded-lg px-4 py-2 text-sm text-slate-300 hover:bg-slate-700 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={busy}
            className="!min-h-[44px] rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            Stop billing and apply
          </button>
        </>
      }
    >
      <ul id={listId} className="flex flex-col gap-2 text-sm text-slate-200">
        {rows.map((r) => (
          <li key={r.featureKey}>
            {keyLabel(r.featureKey)}.{" "}
            {r.manual ? "Remove it from their manual invoice." : "Billing stops now."}
          </li>
        ))}
      </ul>
    </AdminModal>
  );
}
