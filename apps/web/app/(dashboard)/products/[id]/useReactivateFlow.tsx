"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useReactivateProduct, useUpdateProduct } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  deactivateFailureToast,
  getReactivationRefusal,
  type ReactivationRefusal,
} from "@/lib/product-reactivation-refusal";
import { ReactivateConflictDialog } from "./ReactivateConflictDialog";

/**
 * WS7: one reactivation flow for the product header and the variant rows. `start(id)` tries the plain
 * reactivation; a code/name 409 opens the conflict dialog, whose one-call resolve resends with the
 * exact holder ids. Any other failure is a generic toast (no server string).
 */
export function useReactivateFlow(opts?: { onReactivated?: (id: string) => void }) {
  const { toast } = useToast();
  const reactivate = useReactivateProduct();
  const update = useUpdateProduct();
  const [deactivating, setDeactivating] = React.useState<{ id: string; name: string } | null>(null);
  const [pending, setPending] = React.useState<{
    id: string;
    refusal: ReactivationRefusal;
  } | null>(null);

  const run = React.useCallback(
    (id: string, deactivateHolderIds?: string[]) => {
      reactivate.mutate(
        { id, deactivateHolderIds },
        {
          onSuccess: () => {
            setPending(null);
            toast({ title: "Product reactivated", variant: "success" });
            opts?.onReactivated?.(id);
          },
          onError: (err) => {
            const refusal = getReactivationRefusal(err);
            if (refusal) setPending({ id, refusal });
            else {
              setPending(null);
              toast({ title: "Couldn't reactivate this product", variant: "error" });
            }
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reactivate.mutate, toast, opts?.onReactivated],
  );

  const confirmDeactivate = () => {
    if (!deactivating) return;
    const { id } = deactivating;
    setDeactivating(null);
    update.mutate(
      { id, isActive: false },
      {
        onSuccess: () => toast({ title: "Product deactivated", variant: "success" }),
        onError: (err) => toast(deactivateFailureToast(err, "Couldn't deactivate this product")),
      },
    );
  };

  const dialog = (
    <>
      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={confirmDeactivate}
        title="Deactivate product?"
        description={`${deactivating?.name ?? "This product"} will be hidden from the catalog and its SKU and barcodes are released for other products. You can reactivate it later if they are still free.`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={update.isPending}
      />
      <ReactivateConflictDialog
        refusal={pending?.refusal ?? null}
        loading={reactivate.isPending}
        onClose={() => setPending(null)}
        onResolve={(ids) => pending && run(pending.id, ids)}
        onRetry={() => pending && run(pending.id)}
      />
    </>
  );

  return {
    start: (id: string) => run(id),
    /** Ask before deactivating: it releases the product's codes. */
    askDeactivate: (id: string, name: string) => setDeactivating({ id, name }),
    dialog,
    isPending: reactivate.isPending || update.isPending,
  };
}
