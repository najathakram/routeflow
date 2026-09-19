"use client";

import * as React from "react";
import type { useToast } from "@routeflow/ui/web";
import { resolveProductByCode } from "@/lib/barcode-resolve";

type ToastFn = ReturnType<typeof useToast>["toast"];

export interface ScanCodeHandlerDeps {
  /** Adds (or increments) a resolved product on the order. */
  addLineItem: (product: any) => void;
  /** Nothing in the catalog matched — the caller opens create-product with `code` as the SKU. */
  onUnknownCode: (code: string) => void;
  toast: ToastFn;
}

/**
 * The create-order barcode handler, moved verbatim out of CreateOrderModal (LANE-S step 4
 * prefactor — behaviour identical, pinned by CreateOrderModal.test.tsx's scan characterization).
 * It is the seam the redesigned scan screen (LANE-S step 5) is meant to reuse so both surfaces
 * resolve a code the same way.
 *
 * Returned as a ref, re-pointed at the latest render's deps every render, so a keydown listener or
 * a camera callback that captured it once never goes stale — the same pattern the modal used
 * inline. Pass `addLineItem` as a thunk if it is declared further down the caller: it is read only
 * when a code is scanned, never at hook-call time.
 *
 * Resolution uses the shared lib ladder (barcode endpoint → candidate-aware scanCode search)
 * instead of the old inline copy, which swallowed 5xx/network errors as "not found" and skipped
 * unitSku on the exact-match check. This surface keeps its historical multi-match behaviour:
 * first row wins (the modal's scan flow has always auto-added; the edit page offers a picker).
 */
export function useScanCodeHandler(deps: ScanCodeHandlerDeps) {
  const handlerRef = React.useRef<(code: string) => void>(() => {});
  handlerRef.current = async (code: string) => {
    try {
      const result = await resolveProductByCode(code);
      if (result.archived) {
        // F30 / R5: the product exists but is retired — never put it on an
        // order silently, and never fall through to "create a new product"
        // for something the catalog already has.
        deps.toast({
          variant: "error",
          title: `${result.product?.name || "Item"} is archived — reactivate to sell`,
        });
        return;
      }
      if (!result.notFound && result.product) {
        deps.addLineItem(result.product); // addLineItem clears search + refocuses
        return;
      }
    } catch (err: any) {
      // Network / 5xx — a transient failure is NOT "product doesn't exist";
      // don't open the create-product modal over it.
      deps.toast({
        variant: "error",
        title: "Couldn't look up the code",
        description:
          err?.response?.data?.message ?? err?.message ?? "Check the connection and rescan.",
      });
      return;
    }
    // Nothing found — let the caller open create-product with the scanned barcode as SKU
    deps.onUnknownCode(code);
  };
  return handlerRef;
}
