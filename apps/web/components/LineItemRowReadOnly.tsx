"use client";

import * as React from "react";
import type { LineComponentView } from "@routeflow/types";
import { backorderTagText } from "@/lib/backorder-tag-text";
import { ComponentSubLines } from "./ComponentSubLines";
import { Package } from "lucide-react";
import { Badge, cn, type BadgeStatus } from "@routeflow/ui/web";
import {
  computeLineSubtotal,
  formatQtySplit,
  invoiceLineQtyText,
  normalizeBoxesPieces,
} from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { objectPositionForUrl } from "@/lib/image-focal";
import { splitProductName } from "@/lib/product-display";
import { linePriceTag } from "./line-price-tag";

/** Prisma `Decimal` columns arrive as strings over the wire (`qty`, `unitPrice`, `subtotal`,
 *  `deliveredQty`), so every numeric prop accepts both and is coerced here — never `.toFixed`
 *  on a raw prop. */
type Numeric = number | string;

export interface LineItemRowReadOnlyProps {
  /** Already composed via `displayProductName` / `orderLineName` — the row never re-derives it. */
  displayName: string;
  sku?: string | null;
  /** Presigned thumbnail URL; falls back to an icon tile in the SAME 40x40 box (no layout shift),
   *  including when the URL has expired and the image fails to load. */
  thumbnailUrl?: string | null;
  /** Selling-unit price: per box for a line with a boxes/pieces split, per piece otherwise. */
  unitPrice: Numeric;
  /** Total pieces (authoritative), as on the order line. */
  qty: Numeric;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  /**
   * Server-stored line subtotal — the agreed money, and what the order and its invoice bill. Pass
   * `OrderItem.subtotal`. Only when it is absent does the row recompute (with `freeUnits`), which
   * is exactly the order page's own rule.
   */
  subtotal?: Numeric | null;
  /** `OrderItem.promoFreeUnits` — BUY_N_GET_M units subtracted by the fallback recompute, and
   *  named on the row ("N free") so a reduced total never reads as a pricing error. */
  freeUnits?: Numeric | null;
  /** `OrderItem.priceType` + `originalPrice`: explains a Special / Upsell / Discounted / Promo /
   *  Adjusted price with the struck list price and a pill (see `linePriceTag`). */
  priceType?: string | null;
  originalPrice?: Numeric | null;
  /** Custom label for the box-level unit (units ladder); defaults to "box". */
  boxLabel?: string | null;
  /** Custom label for loose pieces; defaults to "pcs". */
  unitLabel?: string | null;
  /** Caller-derived line outcome (`displayLineStatus` on the order page) — the row only renders
   *  it. A `CANCELLED` line strikes the name and shows "—" for the total, as the table did. */
  lineStatus?: BadgeStatus;
  deliveredQty?: Numeric | null;
  /** Show "N of M delivered" for a short-picked line. The CALLER sets this only once the order is
   *  past DRAFT/PENDING — `deliveredQty` is 0 (not null) on every undelivered line. */
  showDeliveryProgress?: boolean;
  note?: string | null;
  /** An ad-hoc (unlisted, non-catalog) line — shows the "Custom" pill the table shows. */
  custom?: boolean;
  /** #2717 M3: frozen components of a composed (mixed-pack) line, shown as "(included)" sub-lines. */
  components?: ReadonlyArray<LineComponentView> | null;
  /** SA-714: pieces sold past stock (staff-only); > 0 shows the "Backorder" tag. Display only. */
  backorderPieces?: number;
  className?: string;
}

/**
 * Read-only order line (order-ui-redesign-spec §3.3) — the order-detail counterpart of the
 * editable `LineItemRow`. A sibling component rather than a `readOnly` prop on `LineItemRow`:
 * that row takes 14 required edit callbacks, so a prop variant would make every read-only caller
 * pass no-ops. Render it inside a `<ul>`.
 *
 * Margin/floor, note editing and remove are deliberately absent — nothing here is repriced.
 */
export function LineItemRowReadOnly({
  displayName,
  sku,
  thumbnailUrl,
  unitPrice: unitPriceProp,
  qty: qtyProp,
  unitsPerBox,
  boxes,
  pieces,
  subtotal,
  freeUnits,
  priceType,
  originalPrice,
  boxLabel,
  unitLabel,
  lineStatus,
  deliveredQty,
  showDeliveryProgress,
  note,
  custom,
  components,
  backorderPieces,
  className,
}: LineItemRowReadOnlyProps) {
  const [imageFailed, setImageFailed] = React.useState(false);
  const { stem, anchor } = splitProductName(displayName);
  const unitPrice = Number(unitPriceProp);
  const qty = Number(qtyProp);
  const cancelled = lineStatus === "CANCELLED";
  // Same predicate as `computeLineSubtotal`: a boxed product WITHOUT a stored split (legacy lines)
  // is priced per piece, so it must read as "qty × price", not "box of N".
  const hasSplit = boxes != null || pieces != null;
  const boxed = hasSplit && !!unitsPerBox && unitsPerBox > 1;
  const total =
    subtotal != null
      ? Number(subtotal)
      : computeLineSubtotal({
          unitPrice,
          qty,
          boxes: boxes ?? null,
          pieces: pieces ?? null,
          unitsPerBox: unitsPerBox ?? null,
          freeUnits: Math.max(0, Math.trunc(Number(freeUnits ?? 0) || 0)),
        });
  const qtyPriceLine = boxed
    ? `${formatQtySplit({ qty, boxes, pieces, unitLabel, boxLabel })} · ${formatMoney(unitPrice)} / ${
        boxLabel?.trim() || "box"
      } of ${unitsPerBox}`
    : hasSplit
      ? // A stored boxes/pieces split but no known pack size: keep the split the operator entered
        // (priced per piece by `computeLineSubtotal`, so the price reads per unit).
        `${formatQtySplit({ qty, boxes, pieces, unitLabel, boxLabel })} × ${formatMoney(unitPrice)}`
      : // #2049: a factor-1 units_v1 line (no split) still carries its own selling-unit name — the
        // caller maps the stored `li.unitLabel` into THIS component's `boxLabel` prop (same as the
        // boxed branch above uses), never its `unitLabel` prop (a different, loose-pieces label).
        // invoiceLineQtyText falls back to formatQtySplit(qty) byte-identical when it's empty.
        `${invoiceLineQtyText({ qty, unitLabel: boxLabel })} × ${formatMoney(unitPrice)}`;
  // `qty` and `deliveredQty` are both PIECES; a boxed line shows its quantity as boxes + pieces, so
  // progress must read in the same units ("0 of 2 boxes + 3 pcs", never "0 of 51").
  const progressText = (n: number) =>
    boxed
      ? formatQtySplit({
          ...normalizeBoxesPieces({ qty: n, unitsPerBox }),
          unitLabel,
          boxLabel,
        })
      : formatQtySplit({ qty: n });
  const delivered = deliveredQty == null ? null : Number(deliveredQty);
  const priceTag = linePriceTag({ priceType, originalPrice, unitPrice });
  const freeCount = Math.max(0, Math.trunc(Number(freeUnits ?? 0) || 0));

  return (
    <li className={cn("flex items-start gap-3 px-3 py-3", cancelled && "opacity-50", className)}>
      {/* Reserved 40x40 in every case so a missing/failed image never shifts the row. */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-raised">
        {thumbnailUrl && !imageFailed ? (
          // Presigned storage URL — next/image's optimizer does not apply.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            onError={() => setImageFailed(true)}
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(thumbnailUrl) }}
          />
        ) : (
          <Package className="h-4 w-4 text-navy/30" aria-hidden />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* Stem (family) clamps hard; the anchor (flavor / pack) only has a generous backstop so a
            brand-prefixed name can never bring back the unbounded-wrap row. */}
        {stem && (
          <p
            data-testid="line-name-stem"
            className={cn("line-clamp-2 text-xs text-navy/70", cancelled && "line-through")}
          >
            {stem}
          </p>
        )}
        <p
          data-testid="line-name-anchor"
          className={cn(
            "text-sm font-medium text-navy [overflow-wrap:anywhere]",
            cancelled && "line-through",
            // No separator → nothing to split: a plain 3-line clamp beats both an unbounded wrap
            // and a 1-line tail truncation.
            stem ? "line-clamp-4" : "line-clamp-3",
          )}
        >
          {anchor}
        </p>
        {sku && <p className="mt-0.5 font-mono text-xs text-navy/60">SKU {sku}</p>}
        {backorderPieces != null && backorderPieces > 0 && (
          <span
            data-testid="line-backorder-tag"
            title={`${backorderPieces} pcs sold past stock`}
            className="mt-1 inline-flex rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200"
          >
            {backorderTagText(backorderPieces)}
          </span>
        )}
        {custom && (
          <span className="mt-1 inline-flex rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
            Custom
          </span>
        )}
        <p className="mt-1 text-xs text-navy/70" title={hasSplit ? `${qty} pcs total` : undefined}>
          {qtyPriceLine}
        </p>
        {priceTag && (
          <p
            className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs"
            data-testid="line-price-tag"
          >
            {priceTag.strikeOriginal && (
              <span className="text-navy/50 line-through">
                {formatMoney(Number(originalPrice))}
              </span>
            )}
            {/* The current price is already on the qty line above — repeating it here read as
                a second, different price on boxed lines. */}
            <span
              className={cn(
                "rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1",
                priceTag.tone === "emerald"
                  ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                  : "bg-amber-50 text-amber-700 ring-amber-200",
              )}
            >
              {priceTag.label}
            </span>
          </p>
        )}
        {freeCount > 0 && (
          <p className="text-[10px] font-medium text-amber-700">{freeCount} free</p>
        )}
        {showDeliveryProgress && !cancelled && delivered != null && delivered < qty && (
          <p className="text-xs text-navy/70">
            {progressText(delivered)} of {progressText(qty)} delivered
          </p>
        )}
        {note?.trim() && (
          <p className="mt-1 whitespace-pre-line text-xs italic text-navy/70">{note.trim()}</p>
        )}
        <ComponentSubLines components={components} />
        {lineStatus && (
          <div className="mt-1.5">
            <Badge status={lineStatus} />
          </div>
        )}
      </div>

      <div className="shrink-0 text-right">
        {cancelled ? (
          <span className="text-sm text-navy/40" aria-label="No charge — line cancelled">
            —
          </span>
        ) : (
          <span className="text-sm font-semibold text-navy">{formatMoney(total)}</span>
        )}
      </div>
    </li>
  );
}
