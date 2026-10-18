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
        // there, else to the first box (the header's Edit prices names no price); only with no box at all does it say
        // where the edits are. The window never opens just to be cancelled again.
        if (live.current.editingIn === "inline") {
          const pick = (selector: string) => {
            const boxes = [...document.querySelectorAll<HTMLElement>(selector)];
            return boxes.find((el) => el.offsetParent !== null) ?? boxes[0];
          };
          const box =
            (next.focus
              ? pick(`[data-testid="${T.input(next.focus.ref, next.focus.tier)}"]`)
              : undefined) ?? pick('[data-testid^="units-v2-input-"]');
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
  const seen = React.useRef<{ id: string; revision: number } | undefined>(undefined);
  React.useEffect(() => {
    if (revision === undefined) return;
    // A revision is only compared with one seen for the SAME product (navigating to another is not a change).
    if (seen.current && seen.current.id === product.id && seen.current.revision !== revision) {
      void qc.invalidateQueries({ queryKey: ["products", product.id], exact: true });
      void qc.invalidateQueries({ queryKey: productUnitsKey(product.id) });
    }
    seen.current = { id: product.id, revision };
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
      {/* Always mounted, so the text it receives is announced. Above the inline Save bar; never takes the pointer. */}
      <p
        role="status"
        data-testid="price-window-note"
        className={cn(
          note &&
            "pointer-events-none fixed bottom-24 left-1/2 z-40 max-w-[90vw] -translate-x-1/2 rounded-lg bg-navy px-3 py-2 text-xs text-white shadow-modal",
          !note && "sr-only",
        )}
      >
        {note}
      </p>
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
  useInertWhileCovering(wide);
  return (
    <div
      data-testid={PRICING_REGION_TESTID}
      data-wide={wide ? "true" : undefined}
      className={cn(
        // motion-safe only: under prefers-reduced-motion there is no transition rule at all (stacking motion-reduce on
        // lg let the later lg: rule win in the built stylesheet).
        "motion-safe:lg:transition-[margin,width] motion-safe:lg:duration-200 motion-safe:lg:ease-out",
        // Opaque and raised while it covers the image column: nothing shows through, and the column is inert.
        wide &&
          "lg:relative lg:z-10 lg:-ml-[calc(50%+0.75rem)] lg:w-[calc(150%+0.75rem)] lg:rounded-lg lg:bg-white lg:shadow-card",
      )}
    >
      {children}
    </div>
  );
}

const LG_QUERY = "(min-width: 1024px)";
/**
 * While the region is wide at lg and up, the column it grows over (marked `data-region-covers` by the page) is inert:
 * its buttons leave the Tab order, so focus can never land on something the grid hides (WCAG 2.4.11). Released the
 * moment the region is not wide, below lg, or gone.
 */
function useInertWhileCovering(wide: boolean) {
  const [lg, setLg] = React.useState(
    () => typeof window !== "undefined" && window.matchMedia?.(LG_QUERY).matches === true,
  );
  React.useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return undefined;
    const mql = window.matchMedia(LG_QUERY);
    const sync = () => setLg(mql.matches);
    sync();
    mql.addEventListener?.("change", sync);
    return () => mql.removeEventListener?.("change", sync);
  }, []);
  React.useEffect(() => {
    if (!wide || !lg) return undefined;
    const covered = [...document.querySelectorAll<HTMLElement>("[data-region-covers]")];
    for (const el of covered) el.setAttribute("inert", "");
    return () => {
      for (const el of covered) el.removeAttribute("inert");
    };
  }, [wide, lg]);
}
