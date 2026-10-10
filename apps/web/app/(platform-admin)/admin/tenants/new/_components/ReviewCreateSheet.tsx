"use client";

import * as React from "react";
import { AdminModal } from "../../../../_components/AdminModal";

/** The review, as plain text per group; the page builds it from the form so the sheet never re-derives money or setup. */
export interface CreateReview {
  businessName: string;
  slug: string;
  adminEmail: string;
  planName: string;
  billingLine: string;
  setupTitle: string;
  setupLines: string[];
  addonLabels: string[];
}

/**
 * ONE "Review and create" step. Opens when the form is submitted and sends nothing: Cancel and Escape close it and keep
 * every input; only its Create Tenant starts the create. A bottom sheet at phone width, a dialog from `sm` up.
 */
export function ReviewCreateSheet({
  open,
  review,
  onCancel,
  onCreate,
}: {
  open: boolean;
  review: CreateReview;
  onCancel: () => void;
  onCreate: () => void;
}) {
  const createRef = React.useRef<HTMLButtonElement>(null);
  return (
    <AdminModal
      open={open}
      onClose={onCancel}
      title={`Create ${review.businessName}?`}
      initialFocusRef={createRef}
      sheet
      footer={
        <>
          <button
            type="button"
            onClick={onCancel}
            className="admin-tap rounded-lg px-4 py-2 text-sm text-slate-400 hover:bg-slate-700"
          >
            Cancel
          </button>
          <button
            ref={createRef}
            type="button"
            onClick={onCreate}
            className="admin-tap rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-500"
          >
            Create Tenant
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <Group id="sheet-account" title="Account">
          <p>
            <span className="font-mono">{review.slug}</span>, admin {review.adminEmail}
          </p>
        </Group>
        <Group id="sheet-plan" title="Plan and billing">
          <p>{review.planName}</p>
          <p className="text-xs text-slate-300">{review.billingLine}</p>
        </Group>
        <Group id="sheet-setup" title={review.setupTitle}>
          <ul className="flex list-disc flex-col gap-0.5 pl-5">
            {review.setupLines.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </Group>
        <Group id="sheet-addons" title="Free add-ons">
          <p>{review.addonLabels.length ? review.addonLabels.join(", ") : "None"}</p>
        </Group>
      </div>
    </AdminModal>
  );
}

function Group({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section
      data-testid={id}
      aria-labelledby={`${id}-title`}
      className="rounded-lg bg-slate-900/40 p-3 ring-1 ring-white/10"
    >
      <h4 id={`${id}-title`} className="text-sm font-semibold text-slate-200">
        {title}
      </h4>
      <div className="mt-1 text-sm text-slate-200">{children}</div>
    </section>
  );
}
