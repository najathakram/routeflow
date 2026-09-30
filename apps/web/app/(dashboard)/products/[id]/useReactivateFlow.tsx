"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useReactivateProduct } from "@/lib/api/products";
import { getReactivationRefusal, type ReactivationRefusal } from "@/lib/product-reactivation-refusal";
import { ReactivateConflictDialog } from "./ReactivateConflictDialog";

/**
 * WS7: one reactivation flow for the product header and the variant rows. `start(id)` tries the plain
 * reactivation; a code/name 409 opens the conflict dialog, whose one-call resolve resends with the
 * exact holder ids. Any other failure is a generic toast (no server string).
 */
export function useReactivateFlow(opts?: { onReactivated?: (id: string) => void }) {
  const { toast } = useToast();
  const reactivate = useReactivateProduct();
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

  const dialog = (
    <ReactivateConflictDialog
      refusal={pending?.refusal ?? null}
      loading={reactivate.isPending}
      onClose={() => setPending(null)}
      onResolve={(ids) => pending && run(pending.id, ids)}
      onRetry={() => pending && run(pending.id)}
    />
  );

  return { start: (id: string) => run(id), dialog, isPending: reactivate.isPending };
}
