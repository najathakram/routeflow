"use client";

import * as React from "react";
import { Button, Modal } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "@/components/dialog-mobile-fit";
import type { ConflictChoice } from "@/lib/order-draft/engine";

export const DRAFT_CONFLICT_COPY =
  "This order was changed on another device. Keep this one or open the other?";

/**
 * SA-817 (A) 2: a 409 DRAFT_CHANGED. Both versions survive either way: the choice only says which one the builder shows;
 * the other is parked in the draft dock. There is no way to dismiss without choosing (the builder stays frozen until then).
 */
export function DraftConflictDialog({
  open,
  busy,
  onChoose,
}: {
  open: boolean;
  busy: boolean;
  onChoose: (choice: ConflictChoice) => void;
}) {
  return (
    <Modal
      open={open}
      onClose={() => undefined}
      title="Changed on another device"
      className={DIALOG_FIT}
      footer={
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            disabled={busy}
            onClick={() => onChoose("open-other")}
          >
            Open the other
          </Button>
          <Button
            className={DIALOG_FOOTER_BUTTON}
            disabled={busy}
            onClick={() => onChoose("keep-mine")}
          >
            Keep this one
          </Button>
        </>
      }
    >
      <p className="text-sm text-navy/70">{DRAFT_CONFLICT_COPY}</p>
      <p className="mt-2 text-sm text-navy/70">Both are kept. Nothing is overwritten.</p>
    </Modal>
  );
}
