"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";

export interface UndoableAction {
  /** Toast title, e.g. "Order line removed" or "Deleted 3 draft invoices". */
  message: string;
  /** Secondary line, e.g. "Cloud Chips BBQ, 2 boxes". */
  description?: string;
  /** The reversible act (usually a server soft-delete). Runs immediately. */
  perform: () => Promise<void> | void;
  /** Restores exactly what `perform` removed (the server restore). */
  undo: () => Promise<void> | void;
  /** Undo window in ms. Design standard is 8 seconds. */
  durationMs?: number;
  /** Called if `perform` (or `undo`) throws, after a failure toast is shown. */
  onError?: (error: unknown) => void;
}

/**
 * The Undo standard (unified/ux-standards.html): reversible and bulk actions
 * execute immediately and offer an 8-second Undo — no confirm dialog. Confirm
 * dialogs are reserved for the truly irreversible (void payment, post filing,
 * delete tenant).
 *
 * Usage:
 *   const runUndoable = useUndo();
 *   runUndoable({
 *     message: "Customer removed",
 *     description: customer.businessName,
 *     perform: () => deleteCustomer(id),   // server soft-delete
 *     undo: () => restoreCustomer(id),      // server restore
 *   });
 */
export function useUndo() {
  const { toast, dismiss } = useToast();

  return React.useCallback(
    async (action: UndoableAction) => {
      const { message, description, perform, undo, durationMs = 8000, onError } = action;
      try {
        await perform();
      } catch (error) {
        toast({ title: "Could not complete that", variant: "error" });
        onError?.(error);
        return;
      }

      let undone = false;
      const holder: { id?: string } = {};
      holder.id = toast({
        title: message,
        description,
        variant: "info",
        duration: durationMs,
        action: {
          label: "Undo",
          onClick: async () => {
            if (undone) return;
            undone = true;
            if (holder.id) dismiss(holder.id);
            try {
              await undo();
              toast({ title: "Restored", variant: "success", duration: 2500 });
            } catch (error) {
              toast({ title: "Could not undo that", variant: "error" });
              onError?.(error);
            }
          },
        },
      });
    },
    [toast, dismiss],
  );
}
