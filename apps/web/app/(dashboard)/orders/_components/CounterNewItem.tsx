"use client";

import * as React from "react";
import Link from "next/link";
import type { SellLevel } from "@routeflow/pricing";
import { Button } from "@routeflow/ui/web";
import { InlineCreateProductModal } from "@/components/InlineCreateProductModal";
import { useTrackedCategories } from "@/lib/api/tracked-categories";
import { newProductPrefill, type PrefillDoor } from "@/lib/product-prefill";
import { scanLevelForHit } from "./scan/useScanCodeHandler";

/**
 * W-1042 (SA-1062): a new item at the counter. Nothing here opens by itself: the miss line's Create item and the live
 * list's Create "<typed>" call `open`. A business with tracked categories is asked one required question first, and Yes
 * stops (a licensed or regulated item is added from Products, so its category and tax are set). Save adds ONE line of 1
 * through the counter's own add path, the same one a scan takes, then hands the cursor back to the scan box.
 */
interface Options {
  /** EDIT_LINE_PRICE and an unlocked sale. False = no door exists. */
  allowed: boolean;
  /** The counter's ONE add path. */
  add: (product: any, level: SellLevel, n: number) => void;
  refocus: () => void;
  /** The item is on the cart: the screen clears the scan box and the miss line. */
  onAdded: () => void;
}

type Step = "ask" | "stopped" | "form";

export function useCounterNewItem({ allowed, add, refocus, onAdded }: Options) {
  const { data: categoryRows, isSuccess } = useTrackedCategories();
  // Unknown (still loading, or the read failed) asks: regulated goods must not slip through on a slow read.
  const asks =
    !isSuccess || (Array.isArray(categoryRows) && categoryRows.some((c) => c.active !== false));
  const [request, setRequest] = React.useState<{
    text: string;
    from: PrefillDoor;
    step: Step;
  } | null>(null);
  const allowedRef = React.useRef(allowed);
  allowedRef.current = allowed;

  const open = (text: string, from: PrefillDoor = "typed") =>
    setRequest({ text, from, step: asks ? "ask" : "form" });
  const close = () => setRequest(null);
  // The cursor goes back once the window is really gone: `refocus` waits while a scan pause is held.
  const wasOpenRef = React.useRef(false);
  React.useEffect(() => {
    if (request) wasOpenRef.current = true;
    else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      refocus();
    }
  }, [request, refocus]);
  const created = (product: any) => {
    if (!allowedRef.current) return; // the sale locked meanwhile: the item exists, the search finds it
    add(product, scanLevelForHit(product.sku ?? "", product), 1);
    onAdded();
  };

  const prefill = request ? newProductPrefill(request.text, request.from) : null;
  const modal = request ? (
    request.step === "form" ? (
      <InlineCreateProductModal
        isOpen
        requirePrice
        initialName={prefill?.name}
        initialSku={prefill?.sku}
        onClose={close}
        onCreated={created}
      />
    ) : (
      <RegulatedQuestion
        stopped={request.step === "stopped"}
        onNo={() => setRequest({ ...request, step: "form" })}
        onYes={() => setRequest({ ...request, step: "stopped" })}
        onClose={close}
      />
    )
  ) : null;
  return { open: allowed ? open : undefined, modal };
}

function RegulatedQuestion({
  stopped,
  onNo,
  onYes,
  onClose,
}: {
  stopped: boolean;
  onNo: () => void;
  onYes: () => void;
  onClose: () => void;
}) {
  const titleId = React.useId();
  // No focus move of its own (the counter has one focus owner): Esc is read at the window so it works wherever focus sits.
  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-state="open"
      data-scan-pause
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4"
    >
      <div className="w-full max-w-md space-y-4 rounded-xl bg-white p-6 shadow-xl">
        {stopped ? (
          <>
            <h2 id={titleId} className="text-base font-semibold text-navy">
              Licensed or regulated item
            </h2>
            <p className="text-sm text-navy">
              Add it from Products, so its category and tax are set.
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" className="min-h-[44px]" onClick={onClose}>
                Close
              </Button>
              <Link
                href="/products"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-h-[44px] items-center rounded-lg bg-brand-500 px-4 text-sm font-medium text-white"
              >
                Open Products
              </Link>
            </div>
          </>
        ) : (
          <>
            <h2 id={titleId} className="text-base font-semibold text-navy">
              Is this a licensed or regulated item?
            </h2>
            <div className="flex flex-wrap justify-end gap-2">
              <Button variant="secondary" className="min-h-[44px]" onClick={onNo}>
                No
              </Button>
              <Button variant="secondary" className="min-h-[44px]" onClick={onYes}>
                Yes
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
