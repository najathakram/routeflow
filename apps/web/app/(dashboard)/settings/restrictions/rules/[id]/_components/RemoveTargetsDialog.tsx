"use client";

import * as React from "react";
import { Button, Modal, Textarea } from "@routeflow/ui/web";
import { REASON_MAX } from "@/lib/restriction-rule-form";

/**
 * "Remove N from this rule?": the confirm for taking products or labels out of a rule. The reason is
 * optional (the server records "Removed from rule" when blank). The caller sends the request, so it can
 * keep this open on a refusal and offer Undo on success.
 */
export function RemoveTargetsDialog({
  count,
  open,
  pending,
  onClose,
  onConfirm,
}: {
  count: number;
  open: boolean;
  pending: boolean;
  onClose: () => void;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = React.useState("");
  const returnFocusTo = React.useRef<HTMLElement | null>(null);
  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Remove ${count} from this rule?`}
      description="They stop being restricted by this rule straight away. You can undo this right after."
      onOpenAutoFocus={() => {
        returnFocusTo.current = document.activeElement as HTMLElement | null;
      }}
      onCloseAutoFocus={(e) => {
        const el = returnFocusTo.current;
        returnFocusTo.current = null;
        if (el && el.isConnected && el !== document.body) {
          e.preventDefault();
          el.focus();
        }
      }}
    >
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (!pending) onConfirm(reason.trim());
        }}
      >
        <Textarea
          label="Reason (optional)"
          rows={2}
          maxLength={REASON_MAX}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        <div className="flex justify-end gap-3 border-t border-surface-border pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" loading={pending}>
            Remove
          </Button>
        </div>
      </form>
    </Modal>
  );
}
