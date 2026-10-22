"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "@/components/dialog-mobile-fit";
import { formatMoney } from "@/lib/format";
import { draftSummary, parkedAgo } from "@/lib/drafts";
import { RESUME_PROMPT_TITLE, type ResumeCandidate } from "@/lib/order-draft/resume";
import type { LocalDraftRecord } from "@/lib/order-draft/storage";
import type { SaleDraft } from "@/lib/api/drafts";

/**
 * SA-817 (A) 3: "Resume your unsent order?" The newest unsent copy is offered; Resume fills the builder from it,
 * "Not now" leaves it on the device (nothing is deleted), "Discard" deletes it for good (only on purpose).
 */
export function ResumeUnsentOrderDialog({
  candidates,
  onResume,
  onDismiss,
  onDiscard,
}: {
  candidates: ResumeCandidate[];
  onResume: (record: LocalDraftRecord) => void;
  onDismiss: () => void;
  onDiscard: (localId: string) => void;
}) {
  const top = candidates[0];
  if (!top) return null;
  const { record, serverMoved } = top;
  const summary = draftSummary({
    id: record.localId,
    kind: "ORDER",
    customerName: record.customerName,
    payload: record.payload,
    createdAt: record.savedAt,
    updatedAt: record.savedAt,
  } as SaleDraft);
  return (
    <Modal
      open
      onClose={onDismiss}
      title={RESUME_PROMPT_TITLE}
      className={DIALOG_FIT}
      footer={
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            onClick={() => onDiscard(record.localId)}
          >
            Discard
          </Button>
          <Button variant="secondary" className={DIALOG_FOOTER_BUTTON} onClick={onDismiss}>
            Not now
          </Button>
          <Button className={DIALOG_FOOTER_BUTTON} onClick={() => onResume(record)}>
            Resume
          </Button>
        </>
      }
    >
      <div className="space-y-1 text-sm text-navy/70">
        <p className="font-medium text-navy">{summary.title}</p>
        <p>
          {summary.itemCount} {summary.itemCount === 1 ? "item" : "items"},{" "}
          {formatMoney(summary.total)}. Saved {parkedAgo(record.savedAt)}.
        </p>
        {candidates.length > 1 && <p>{candidates.length - 1} more unsent on this device.</p>}
        {serverMoved && <p>The saved copy on your account was changed on another device.</p>}
      </div>
    </Modal>
  );
}
