"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { Badge, cn, type BadgeStatus } from "@routeflow/ui/web";
import { computeLineSubtotal, formatQtySplit } from "@routeflow/pricing";
import { formatMoney } from "@/lib/format";
import { objectPositionForUrl } from "@/lib/image-focal";
import { splitProductName } from "@/lib/product-display";

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
  /** `OrderItem.promoFreeUnits` — BUY_N_GET_M units subtracted by the fallback recompute. */
  freeUnits?: Numeric | null;
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
  boxLabel,
  unitLabel,
  lineStatus,
  deliveredQty,
  showDeliveryProgress,
  note,
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
    : `${formatQtySplit({ qty })} × ${formatMoney(unitPrice)}`;
  const delivered = deliveredQty == null ? null : Number(deliveredQty);

  return (
    <li className={cn("flex items-start gap-3 px-3 py-3", className)}>
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

      <div className={cn("min-w-0 flex-1", cancelled && "text-navy/50 line-through")}>
        {/* Stem (family) clamps hard; the anchor (flavor / pack) only has a generous backstop so a
            brand-prefixed name can never bring back the unbounded-wrap row. */}
        {stem && (
          <p data-testid="line-name-stem" className="line-clamp-2 text-xs text-navy/70">
            {stem}
          </p>
        )}
        <p
          data-testid="line-name-anchor"
          className={cn(
            "text-sm font-medium text-navy [overflow-wrap:anywhere]",
            // No separator → nothing to split: a plain 3-line clamp beats both an unbounded wrap
            // and a 1-line tail truncation.
            stem ? "line-clamp-4" : "line-clamp-3",
          )}
        >
          {anchor}
        </p>
        {sku && <p className="mt-0.5 font-mono text-xs text-navy/60">SKU {sku}</p>}
        <p className="mt-1 text-xs text-navy/70">{qtyPriceLine}</p>
        {showDeliveryProgress && delivered != null && delivered < qty && (
          <p className="text-xs text-navy/70">
            {formatQtySplit({ qty: delivered })} of {formatQtySplit({ qty })} delivered
          </p>
        )}
        {note?.trim() && <p className="mt-1 text-xs italic text-navy/70">{note.trim()}</p>}
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
