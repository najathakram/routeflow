"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { Eye, EyeOff } from "lucide-react";
import {
  computeMarginFraction,
  priceForMarginFloor,
  classifyMargin,
  costPerSellingUnit,
} from "@routeflow/pricing";
import { useCostHistory } from "@/lib/api/cost-history";

/** Short label for a StockMovement type shown in the cost-history popover. */
function costTypeLabel(type: string): string {
  if (type === "PURCHASE") return "Bill";
  if (type === "COST_BASIS") return "Manual";
  return type.replace(/_/g, " ").toLowerCase();
}

/**
 * The bills/lots behind the cost number (pos-cost-roles-spec §1: "Tapping the
 * cost opens the cost history"). Portaled to <body> so it escapes the sale
 * builder modal's `transform` + `overflow` clipping; positioned under the anchor.
 */
function CostHistoryPopover({
  productId,
  anchor,
  onClose,
}: {
  productId: string;
  anchor: HTMLElement;
  onClose: () => void;
}) {
  const { data: history = [], isLoading } = useCostHistory(productId);
  const ref = React.useRef<HTMLDivElement>(null);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);

  React.useLayoutEffect(() => {
    const r = anchor.getBoundingClientRect();
    // Keep the 15rem-wide card on screen horizontally.
    const left = Math.min(r.left, window.innerWidth - 240 - 8);
    setPos({ top: r.bottom + 4, left: Math.max(8, left) });
  }, [anchor]);

  React.useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current && !ref.current.contains(t) && !anchor.contains(t)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The builder is a Radix Dialog whose Escape-to-close listener runs on
      // `document` in the capture phase. A window capture-phase listener fires
      // BEFORE that, so we stop propagation here — Escape closes only this
      // popover, never the whole sale builder (which would discard the order).
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [anchor, onClose]);

  if (pos == null) return null;
  // Newest first, cap at the most recent 6 entries.
  const recent = [...history].slice(-6).reverse();

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Cost history"
      style={{ position: "fixed", top: pos.top, left: pos.left }}
      className="z-[300] w-60 rounded-lg border border-surface-border bg-white p-2 shadow-modal"
    >
      <p className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-navy/50">
        Cost history
      </p>
      {isLoading ? (
        <p className="px-1 py-1 text-[11px] text-navy/50">Loading…</p>
      ) : recent.length === 0 ? (
        <p className="px-1 py-1 text-[11px] text-navy/50">No purchase cost history yet.</p>
      ) : (
        <ul className="space-y-0.5">
          {recent.map((h, i) => (
            <li key={i} className="flex items-center gap-2 px-1 text-[11px]">
              <span className="text-navy/60">
                {new Date(h.date).toLocaleDateString(undefined, {
                  month: "short",
                  day: "numeric",
                })}
              </span>
              <span className="rounded bg-sunken px-1 text-[9px] uppercase tracking-wide text-navy/50">
                {costTypeLabel(h.type)}
              </span>
              <span className="ml-auto font-mono text-navy">${h.unitCost.toFixed(4)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>,
    document.body,
  );
}

/**
 * Live cost/margin hint — the "negotiation floor" (pos-cost-roles-spec §1).
 * Shows `cost $X.XX · margin %` beneath a line's price. Below cost or below the
 * floor it turns red and offers a one-tap "Set to floor $Y" fix plus "Sell
 * anyway" (which the caller logs). Renders nothing when the cost is unknown.
 *
 * When `productId` is given, the cost value is tappable and opens the cost
 * history (the bills/lots behind the number).
 */
export function MarginHint({
  unitPrice,
  unitCost,
  unitsPerBox,
  floor,
  acked,
  productId,
  onSetToFloor,
  onSellAnyway,
  concealed,
  onToggleConcealed,
}: {
  unitPrice: number;
  unitCost: number | null | undefined;
  unitsPerBox?: number | null;
  floor: number;
  acked?: boolean;
  /** Catalog product id — enables the tap-to-open cost-history popover. */
  productId?: string | null;
  onSetToFloor?: (floorPrice: number) => void;
  onSellAnyway?: () => void;
  /**
   * Cost-eye mode: when true, the cost/margin text is hidden behind an Eye
   * toggle (privacy at the counter). Below-floor warnings + actions STILL
   * render — the floor is a selling price, not raw cost. Callers that don't
   * pass this keep the always-visible behavior.
   */
  concealed?: boolean;
  onToggleConcealed?: () => void;
}) {
  const [historyOpen, setHistoryOpen] = React.useState(false);
  const costRef = React.useRef<HTMLButtonElement>(null);

  if (unitCost == null) return null;
  const margin = computeMarginFraction(unitPrice, unitCost, unitsPerBox);
  if (margin == null) return null;
  const cls = classifyMargin(margin, floor);
  const cost = costPerSellingUnit(Number(unitCost), unitsPerBox);
  const below = cls === "belowFloor" || cls === "belowCost";
  const color = below ? "text-danger" : cls === "warn" ? "text-amber-600" : "text-navy/40";
  const floorPrice = priceForMarginFloor(Number(unitCost), floor, unitsPerBox);
  const costText = `cost $${cost.toFixed(2)} · ${(margin * 100).toFixed(1)}%`;

  return (
    <div className="flex flex-wrap items-center gap-2">
      {concealed ? (
        <button
          type="button"
          onClick={onToggleConcealed}
          title="Show cost & margin"
          className="rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
          data-testid="cost-eye"
        >
          <Eye className="h-3.5 w-3.5" />
        </button>
      ) : (
        <>
          {productId ? (
            <button
              ref={costRef}
              type="button"
              onClick={() => setHistoryOpen((o) => !o)}
              title="View cost history"
              className={`font-mono text-[10px] underline decoration-dotted underline-offset-2 ${color}`}
            >
              {costText}
            </button>
          ) : (
            <span className={`font-mono text-[10px] ${color}`}>{costText}</span>
          )}
          {onToggleConcealed && (
            <button
              type="button"
              onClick={onToggleConcealed}
              title="Hide cost"
              className="rounded p-0.5 text-navy/30 transition-colors hover:bg-surface-raised hover:text-navy"
              data-testid="cost-eye-off"
            >
              <EyeOff className="h-3.5 w-3.5" />
            </button>
          )}
        </>
      )}
      {historyOpen && !concealed && productId && costRef.current && (
        <CostHistoryPopover
          productId={productId}
          anchor={costRef.current}
          onClose={() => setHistoryOpen(false)}
        />
      )}
      {below && !acked && onSetToFloor && (
        <>
          <button
            type="button"
            onClick={() => onSetToFloor(floorPrice)}
            className="rounded border border-danger/30 px-1.5 py-0.5 text-[10px] font-semibold text-danger transition-colors hover:bg-danger-bg"
          >
            Set to floor ${floorPrice.toFixed(2)}
          </button>
          {onSellAnyway && (
            <button
              type="button"
              onClick={onSellAnyway}
              className="text-[10px] font-semibold text-navy/50 underline underline-offset-2 hover:text-navy"
            >
              Sell anyway
            </button>
          )}
        </>
      )}
    </div>
  );
}
