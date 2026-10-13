"use client";

import * as React from "react";
import { useToast } from "@routeflow/ui/web";
import { useDeactivateProduct, useReactivateProduct } from "@/lib/api/products";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import {
  codeTakenOnSubmit,
  deactivateFailureToast,
  getReactivationRefusal,
  isReadOnlyRefusal,
  type ReactivationRefusal,
} from "@/lib/product-reactivation-refusal";
import { ReactivateConflictDialog, type NewCodes } from "./ReactivateConflictDialog";

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
  const [pending, setPending] = React.useState<{
    id: string;
    kind: ProductKind;
    name?: string;
    refusal: ReactivationRefusal;
  } | null>(null);
  // Codes the server refused on a new-code submit (a 400, or the write's 409 CODE_TAKEN / BARCODE_TAKEN):
  // the dialog stays open on its new-code step and flags them inline.
  const [rejected, setRejected] = React.useState<NewCodes | null>(null);
  // A second click before the first request settles must not send a second PATCH.
  const inFlight = React.useRef(false);

  const run = React.useCallback(
    (
      id: string,
      kind: ProductKind,
      name?: string,
      extra?: { deactivateHolderIds?: string[]; newCodes?: NewCodes },
    ) => {
      if (inFlight.current) return;
      inFlight.current = true;
      setRejected(null);
      reactivate.mutate(
        { id, ...extra },
        {
          onSettled: () => {
            inFlight.current = false;
          },
          onSuccess: () => {
            setPending(null);
            setRejected(null);
            toast({ title: `${Noun(kind)} reactivated`, variant: "success" });
            opts?.onReactivated?.(id);
          },
          onError: (err) => {
            // A request that carried replacement codes and was refused on one of them (the 400, or the
            // write's own 409 CODE_TAKEN / BARCODE_TAKEN): stay on the new-code step, typed codes kept,
            // the refused one flagged. A request without new codes keeps the holders / retry refusal.
            const takenField = extra?.newCodes ? codeTakenOnSubmit(err, extra.newCodes) : null;
            const refusal = takenField ? null : getReactivationRefusal(err);
            if (takenField && extra?.newCodes) {
              const next: NewCodes = {};
              next[takenField] = extra.newCodes[takenField];
              setRejected(next);
            } else if (refusal) {
              setPending({ id, kind, name, refusal });
            } else {
              setPending(null);
              // READ_ONLY already got the global "workspace is read-only" toast: no second one.
              if (!isReadOnlyRefusal(err)) {
                toast({ title: `Couldn't reactivate this ${noun(kind)}`, variant: "error" });
              }
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
    const { id, kind } = deactivating;
    setDeactivating(null);
    deactivate.mutate(id, {
      onSuccess: () => toast({ title: `${Noun(kind)} deactivated`, variant: "success" }),
      onError: (err) => {
        if (isReadOnlyRefusal(err)) return;
        toast(deactivateFailureToast(err, `Couldn't deactivate this ${noun(kind)}`));
      },
    });
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
      <ReactivateConflictDialog
        refusal={pending?.refusal ?? null}
        productName={pending?.name}
        rejectedCodes={rejected}
        loading={reactivate.isPending}
        onClose={() => {
          setPending(null);
          setRejected(null);
        }}
        onResolve={(ids) =>
          pending && run(pending.id, pending.kind, pending.name, { deactivateHolderIds: ids })
        }
        onResolveWithCodes={(codes) =>
          pending && run(pending.id, pending.kind, pending.name, { newCodes: codes })
        }
        onRetry={() => pending && run(pending.id, pending.kind, pending.name)}
      />
    </>
  );

  return {
    /** `name` is the product's name, shown in the conflict dialog's new-code step. */
    start: (id: string, kind: ProductKind = "product", name?: string) => run(id, kind, name),
    /** Ask before deactivating: it releases the product's codes. */
    askDeactivate: (id: string, name: string, kind: ProductKind = "product") =>
      setDeactivating({ id, name, kind }),
    dialog,
    isPending: reactivate.isPending || deactivate.isPending,
  };
}
