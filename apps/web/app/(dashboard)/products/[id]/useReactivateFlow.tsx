"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useDeactivateProduct, useReactivateProduct } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  deactivateFailureToast,
  getReactivationRefusal,
  isReadOnlyRefusal,
  type ReactivationRefusal,
} from "@/lib/product-reactivation-refusal";
import { getFamilyCascadePrompt, type FamilyCascadePrompt } from "@/lib/product-family-cascade";
import { ReactivateConflictDialog } from "./ReactivateConflictDialog";

export type ProductKind = "product" | "variant";
const noun = (k: ProductKind) => (k === "variant" ? "variant" : "product");
const Noun = (k: ProductKind) => (k === "variant" ? "Variant" : "Product");

/**
 * WS7: one reactivation flow for the product header and the variant rows. `start(id)` tries the plain
 * reactivation; a code/name 409 opens the conflict dialog, whose one-call resolve resends with the
 * exact holder ids. Any other failure is a generic toast (no server string).
 */
export function useReactivateFlow(opts?: { onReactivated?: (id: string) => void }) {
  const { toast } = useToast();
  const reactivate = useReactivateProduct();
  const deactivate = useDeactivateProduct();
  const [deactivating, setDeactivating] = React.useState<{
    id: string;
    name: string;
    kind: ProductKind;
  } | null>(null);
  // 409 FAMILY_HAS_ACTIVE_VARIANTS: ask once; only the operator's confirm resends with confirmCascade.
  const [cascade, setCascade] = React.useState<{
    id: string;
    kind: ProductKind;
    prompt: FamilyCascadePrompt;
  } | null>(null);
  const [pending, setPending] = React.useState<{
    id: string;
    kind: ProductKind;
    refusal: ReactivationRefusal;
  } | null>(null);

  const run = React.useCallback(
    (id: string, kind: ProductKind, deactivateHolderIds?: string[]) => {
      reactivate.mutate(
        { id, deactivateHolderIds },
        {
          onSuccess: () => {
            setPending(null);
            toast({ title: `${Noun(kind)} reactivated`, variant: "success" });
            opts?.onReactivated?.(id);
          },
          onError: (err) => {
            const refusal = getReactivationRefusal(err);
            if (refusal) setPending({ id, kind, refusal });
            else {
              setPending(null);
              // READ_ONLY already got the global "workspace is read-only" toast: no second one.
              if (!isReadOnlyRefusal(err)) {
                toast(deactivateFailureToast(err, `Couldn't reactivate this ${noun(kind)}`));
              }
            }
          },
        },
      );
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [reactivate.mutate, toast, opts?.onReactivated],
  );

  const runDeactivate = (id: string, kind: ProductKind, confirmCascade?: boolean) => {
    deactivate.mutate(confirmCascade ? { id, confirmCascade } : { id }, {
      onSuccess: () => toast({ title: `${Noun(kind)} deactivated`, variant: "success" }),
      onError: (err) => {
        if (isReadOnlyRefusal(err)) return;
        const prompt = confirmCascade ? null : getFamilyCascadePrompt(err);
        if (prompt) {
          setCascade({ id, kind, prompt });
          return;
        }
        toast(deactivateFailureToast(err, `Couldn't deactivate this ${noun(kind)}`));
      },
    });
  };

  const confirmDeactivate = () => {
    if (!deactivating) return;
    const { id, kind } = deactivating;
    setDeactivating(null);
    runDeactivate(id, kind);
  };

  const dialog = (
    <>
      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={confirmDeactivate}
        title={`Deactivate ${noun(deactivating?.kind ?? "product")}?`}
        description={`${deactivating?.name ?? "This"} will be hidden from the catalog and its SKU, barcodes and unit code are released for other products. You can reactivate it later if they are still free.`}
        confirmLabel="Deactivate"
        variant="danger"
        loading={deactivate.isPending}
      />
      <ConfirmDialog
        open={cascade !== null}
        onClose={() => setCascade(null)}
        onConfirm={() => {
          if (!cascade) return;
          const { id, kind } = cascade;
          setCascade(null);
          runDeactivate(id, kind, true);
        }}
        title={cascade?.prompt.title ?? ""}
        description={cascade?.prompt.body}
        confirmLabel={cascade?.prompt.confirmText}
        variant="danger"
        loading={deactivate.isPending}
      />
      <ReactivateConflictDialog
        refusal={pending?.refusal ?? null}
        loading={reactivate.isPending}
        onClose={() => setPending(null)}
        onResolve={(ids) => pending && run(pending.id, pending.kind, ids)}
        onRetry={() => pending && run(pending.id, pending.kind)}
      />
    </>
  );

  return {
    start: (id: string, kind: ProductKind = "product") => run(id, kind),
    /** Ask before deactivating: it releases the product's codes. */
    askDeactivate: (id: string, name: string, kind: ProductKind = "product") =>
      setDeactivating({ id, name, kind }),
    dialog,
    isPending: reactivate.isPending || deactivate.isPending,
  };
}
