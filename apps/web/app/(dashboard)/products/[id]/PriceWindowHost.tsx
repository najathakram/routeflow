"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { useQueryClient } from "@tanstack/react-query";
import { productUnitsKey } from "@/lib/api/product-units";
import { usePriceGrid } from "@/lib/api/usePriceGrid";
import type { UnitsCardProduct } from "./ProductUnitsCard";
import { UNITS_V2_TESTIDS as T } from "./units-v2-testids";
import { PriceDraftProvider, usePriceDraftOptional } from "./units-v2/edit/PriceDraftProvider";
import { PriceEditWindow } from "./units-v2/window/PriceEditWindow";

/**
 * K11-20c: the product page's price host. One PriceDraftProvider for the whole Details-to-pricing region (so the inline
 * grid, the legacy card, Details and the floating window share ONE draft), and the one PriceEditWindow, opened by
 * whichever figure was clicked. It renders nothing of this when disabled (flag off, a family, a governed product), so
 * those pages are exactly as before.
 */
export interface PriceWindowRequest {
  /** What was clicked (the card's Edit prices button or a price figure): the window grows out of it. */
  origin: HTMLElement | null;
  /** The card the window hangs off. */
  anchor: HTMLElement | null;
  /** The price to open on; without it, the first editable box. */
  focus?: { ref: string; tier: number };
  /** Where focus goes on close when `origin` is gone (the card heading). */
  fallback?: () => HTMLElement | null | undefined;
}
export interface PriceWindowOpener {
  open: (request: PriceWindowRequest) => void;
}

const OpenerContext = React.createContext<PriceWindowOpener | null>(null);

/** The opener when a host is above, else null (flag off, or a page the window does not serve). */
export const usePriceWindowOpener = (): PriceWindowOpener | null => React.useContext(OpenerContext);

type HostProduct = UnitsCardProduct & { msrp?: number | string | null; name?: string | null };

export function PriceWindowHost({
  product,
  enabled,
  children,
}: {
  product: HostProduct;
  enabled: boolean;
  children: React.ReactNode;
}) {
  if (!enabled) return <>{children}</>;
  return (
    <PriceDraftProvider productId={product.id}>
      <HostBody product={product}>{children}</HostBody>
    </PriceDraftProvider>
  );
}

function HostBody({ product, children }: { product: HostProduct; children: React.ReactNode }) {
  const draft = usePriceDraftOptional();
  const qc = useQueryClient();
  const [open, setOpen] = React.useState(false);
  const [request, setRequest] = React.useState<PriceWindowRequest | null>(null);
  const [note, setNote] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (!note) return undefined;
    const t = window.setTimeout(() => setNote(null), 6000);
    return () => window.clearTimeout(t);
  }, [note]);
  const live = React.useRef({ editingIn: draft?.editingIn ?? null, request });
  live.current = { editingIn: draft?.editingIn ?? null, request };

  const opener = React.useMemo<PriceWindowOpener>(
    () => ({
      open: (next) => {
        // One editing surface at a time. The inline grid is already editing, so the click goes to the matching box
        // there (or says where the edits are); the window never opens just to be cancelled again.
        if (live.current.editingIn === "inline") {
          const boxes = next.focus
            ? [
                ...document.querySelectorAll<HTMLElement>(
                  `[data-testid="${T.input(next.focus.ref, next.focus.tier)}"]`,
                ),
              ]
            : [];
          const box = boxes.find((el) => el.offsetParent !== null) ?? boxes[0];
          if (box) {
            box.focus({ preventScroll: true });
            box.scrollIntoView?.({ block: "nearest" });
            setNote(null);
          } else {
            setNote("Prices are being edited in the grid. Save or cancel there first.");
          }
          return;
        }
        setNote(null);
        setRequest(next);
        setOpen(true);
      },
    }),
    [],
  );
  const returnFocus = React.useCallback(() => {
    const r = live.current.request;
    return r?.origin?.isConnected ? r.origin : (r?.fallback?.() ?? null);
  }, []);

  // R1: a v2 save (or Undo, or a stale reload) writes only the price-grid cache. The product and the unit list that
  // Details and the card read refresh whenever the served grid's revision moves, so nothing re-sends an old price.
  const revision = usePriceGrid(product.id).data?.revision;
  const seen = React.useRef<number | undefined>(undefined);
  React.useEffect(() => {
    if (revision === undefined) return;
    if (seen.current !== undefined && seen.current !== revision) {
      void qc.invalidateQueries({ queryKey: ["products", product.id], exact: true });
      void qc.invalidateQueries({ queryKey: productUnitsKey(product.id) });
    }
    seen.current = revision;
  }, [revision, product.id, qc]);

  return (
    <OpenerContext.Provider value={opener}>
      {children}
      <PriceEditWindow
        product={product}
        open={open}
        anchor={request?.anchor}
        origin={request?.origin}
        focus={request?.focus}
        returnFocus={returnFocus}
        onClose={() => setOpen(false)}
      />
      {note && (
        <p
          role="status"
          data-testid="price-window-note"
          className="fixed bottom-4 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-navy px-3 py-2 text-xs text-white shadow-modal"
        >
          {note}
        </p>
      )}
    </OpenerContext.Provider>
  );
}

/** The test id of the prices section's wrapper (a literal: the shared testid map belongs to the editor's package). */
export const PRICING_REGION_TESTID = "units-v2-region";

/**
 * K11-10 ruling: while the INLINE editor edits, the prices grid takes the full page width at lg and up (the 2/3 column
 * is too narrow for five tiers in edit mode). The section keeps its place in the column, so nothing remounts and the
 * focused box does not move vertically; it grows leftward over the image column by exactly that column and its gap
 * (the grid's `gap-6`). 200 ms ease-out, none under prefers-reduced-motion, and every class is lg-only, so nothing
 * changes below lg. The window edits over the page and never widens it.
 */
export function ProductPricingRegion({ children }: { children: React.ReactNode }) {
  const wide = usePriceDraftOptional()?.editingIn === "inline";
  return (
    <div
      data-testid={PRICING_REGION_TESTID}
      data-wide={wide ? "true" : undefined}
      className={cn(
        "lg:transition-[margin,width] lg:duration-200 lg:ease-out motion-reduce:lg:transition-none",
        wide && "lg:relative lg:z-10 lg:-ml-[calc(50%+0.75rem)] lg:w-[calc(150%+0.75rem)]",
      )}
    >
      {children}
    </div>
  );
}
