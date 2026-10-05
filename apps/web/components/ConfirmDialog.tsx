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
  /** "danger" = red button, "secondary" = neutral button */
  variant?: "danger" | "secondary";
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
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      className={DIALOG_FIT}
      footer={
        <>
          <Button
            variant="secondary"
            className={DIALOG_FOOTER_BUTTON}
            onClick={onClose}
            disabled={loading}
          >
            {cancelLabel}
          </Button>
          <Button
            variant={variant}
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
