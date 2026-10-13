"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useDeleteProduct } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { deactivateFailureToast, isReadOnlyRefusal } from "@/lib/product-reactivation-refusal";
import { getFamilyCascadePrompt, type FamilyCascadePrompt } from "@/lib/product-family-cascade";

export type DeleteOutcome = "deleted" | "prompted" | "failed";
export interface StartOptions {
  /** Called once the first DELETE settled: deleted, handed to the cascade prompt, or failed. */
  onSettled?: (outcome: DeleteOutcome) => void;
}

/**
 * Delete one product. A family that still has ACTIVE variants answers 409 FAMILY_HAS_ACTIVE_VARIANTS: the
 * operator is asked once (fixed copy, never the server message) and only the confirmed resend carries
 * `confirmCascade`. Any other failure is one fixed toast.
 */
export function useDeleteProductFlow(opts?: { onDeleted?: (id: string) => void }) {
  const { toast } = useToast();
  const del = useDeleteProduct();
  const [cascade, setCascade] = React.useState<{
    id: string;
    prompt: FamilyCascadePrompt;
  } | null>(null);

  const run = (id: string, confirmCascade?: boolean, opts2?: StartOptions) => {
    del.mutate(confirmCascade ? { id, confirmCascade } : { id }, {
      onSuccess: () => {
        toast({ title: "Product deleted", variant: "success" });
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
