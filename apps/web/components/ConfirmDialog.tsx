"use client";

import * as React from "react";
import { AlertTriangle } from "lucide-react";
import { Modal, Button } from "@routeflow/ui/web";
import { DIALOG_FIT, DIALOG_FOOTER_BUTTON } from "./dialog-mobile-fit";

// ─── ConfirmDialog ─────────────────────────────────────────────────────────────
// Lightweight wrapper around Modal for simple yes/no destructive confirmations.

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  description?: string;
  confirmLabel?: string;
  /** Label of the dismiss button — default "Cancel". Set it where "Cancel" would be ambiguous
   *  (e.g. confirming a cancellation: "Keep my plan"). */
  cancelLabel?: string;
  /** "danger" = red button (opens with focus on Cancel), "warning" = primary button + amber icon
   *  (reversible actions such as Deactivate), "secondary" = neutral button */
  variant?: "danger" | "secondary" | "warning";
  loading?: boolean;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  description,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  variant = "danger",
  loading = false,
}: ConfirmDialogProps) {
  const cancelRef = React.useRef<HTMLButtonElement>(null);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      className={DIALOG_FIT}
      // A destructive confirm must not be one Enter away: focus lands on Cancel, not the close X.
      onOpenAutoFocus={
        variant === "danger"
          ? (e) => {
              e.preventDefault();
              cancelRef.current?.focus();
            }
          : undefined
      }
      footer={
        <>
          <Button
            ref={cancelRef}
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            onClick={onClose}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant === "warning" ? "primary" : variant}
            className={DIALOG_FOOTER_BUTTON}
            onClick={onConfirm}
            loading={loading}
          >
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="flex items-start gap-3">
        <AlertTriangle
          className={`mt-0.5 h-5 w-5 shrink-0 ${variant === "danger" ? "text-danger" : "text-warning"}`}
        />
        <p className="text-sm text-navy/70">
          {description ?? "This action cannot be undone. Are you sure?"}
        </p>
      </div>
    </Modal>
  );
}
