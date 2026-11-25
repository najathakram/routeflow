"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useDeleteProduct, useReactivateProduct } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { deactivateFailureToast, isReadOnlyRefusal } from "@/lib/product-reactivation-refusal";
import { getFamilyCascadePrompt, type FamilyCascadePrompt } from "@/lib/product-family-cascade";

/** Long enough to read "Product deleted" and reach Undo (a plain toast is gone in 4 seconds). */
const UNDO_TOAST_MS = 10_000;

export type DeleteOutcome = "deleted" | "prompted" | "failed";
export interface StartOptions {
  /** Called once the first DELETE settled: deleted, handed to the cascade prompt, or failed. */
  onSettled?: (outcome: DeleteOutcome) => void;
}

/**
 * Delete one product. A family that still has ACTIVE variants answers 409 FAMILY_HAS_ACTIVE_VARIANTS: the
 * operator is asked once (fixed copy, never the server message) and only the confirmed resend carries
 * `confirmCascade`. Any other failure is one fixed toast.
 *
 * UX audit 2026-11-24 F07: a delete only switches the product off, so "Product deleted" carries Undo, which switches
 * it back on. A family deleted together with its variants gets no Undo: it would bring back the family alone.
 */
export function useDeleteProductFlow(opts?: {
  onDeleted?: (id: string) => void;
  /** Called once Undo has switched the product back on. */
  onRestored?: (id: string) => void;
}) {
  const { toast } = useToast();
  const del = useDeleteProduct();
  const reactivate = useReactivateProduct();
  // One Undo per delete: a second click while the first is on its way, or after it worked, sends nothing.
  const undoing = React.useRef(new Set<string>());
  const undo = (id: string) => {
    if (undoing.current.has(id)) return;
    undoing.current.add(id);
    reactivate.mutateAsync({ id }).then(
      () => {
        toast({ title: "Product is back", variant: "success" });
        opts?.onRestored?.(id);
      },
      () => {
        undoing.current.delete(id);
        toast({
          title: "Couldn't bring it back",
          description: "Find it under Inactive in Products and choose Reactivate.",
          variant: "error",
        });
      },
    );
  };
  const [cascade, setCascade] = React.useState<{
    id: string;
    prompt: FamilyCascadePrompt;
  } | null>(null);

  const run = (id: string, confirmCascade?: boolean, opts2?: StartOptions) => {
    del.mutate(confirmCascade ? { id, confirmCascade } : { id }, {
      onSuccess: () => {
        toast({
          title: "Product deleted",
          variant: "success",
          ...(confirmCascade
            ? {}
            : { action: { label: "Undo", onClick: () => undo(id) }, duration: UNDO_TOAST_MS }),
        });
        opts2?.onSettled?.("deleted");
        opts?.onDeleted?.(id);
      },
      onError: (err) => {
        // READ_ONLY already got the global "workspace is read-only" toast.
        if (isReadOnlyRefusal(err)) {
          opts2?.onSettled?.("failed");
          return;
        }
        const prompt = confirmCascade ? null : getFamilyCascadePrompt(err, "delete");
        if (prompt) {
          setCascade({ id, prompt });
          opts2?.onSettled?.("prompted");
          return;
        }
        opts2?.onSettled?.("failed");
        toast(deactivateFailureToast(err, "Failed to delete product"));
      },
    });
  };

  const dialog = (
    <ConfirmDialog
      open={cascade !== null}
      onClose={() => setCascade(null)}
      onConfirm={() => {
        if (!cascade) return;
        const { id } = cascade;
        setCascade(null);
        run(id, true);
      }}
      title={cascade?.prompt.title ?? ""}
      description={cascade?.prompt.body}
      confirmLabel={cascade?.prompt.confirmText}
      variant="danger"
      loading={del.isPending}
    />
  );

  return {
    start: (id: string, o?: StartOptions) => run(id, undefined, o),
    dialog,
    isPending: del.isPending,
  };
}
