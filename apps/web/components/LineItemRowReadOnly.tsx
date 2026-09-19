"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { Badge, cn, type BadgeStatus } from "@routeflow/ui/web";
import { computeLineSubtotal, formatQtySplit } from "@routeflow/pricing";
import { objectPositionForUrl } from "@/lib/image-focal";
import { splitProductName } from "@/lib/product-display";

export interface LineItemRowReadOnlyProps {
  /** Already composed via `displayProductName` / `orderLineName` — the row never re-derives it. */
  displayName: string;
  sku?: string | null;
  /** Presigned thumbnail URL; falls back to an icon tile in the SAME 40x40 box (no layout shift). */
  thumbnailUrl?: string | null;
  /** Selling-unit price (per box for a boxed line). */
  unitPrice: number;
  /** Total pieces (authoritative), as on the order line. */
  qty: number;
  unitsPerBox?: number | null;
  boxes?: number | null;
  pieces?: number | null;
  /** Caller-derived line outcome (`displayLineStatus` on the order page) — the row only renders it. */
  lineStatus?: BadgeStatus;
  /** Shown as "N of M delivered" only when set and short of `qty`. */
  deliveredQty?: number | null;
  note?: string | null;
  className?: string;
}

/**
 * Read-only order line (order-ui-redesign-spec §3.3) — the order-detail counterpart of the
 * editable `LineItemRow`. A sibling component rather than a `readOnly` prop on `LineItemRow`:
 * that row takes 14 required edit callbacks, so a prop variant would make every read-only caller
 * pass no-ops. Both share the same anatomy contract (name / SKU / qty·price / total) and the
 * same pricing helpers, so the read and edit paths cannot drift on the money.
 *
 * Margin/floor, note editing and remove are deliberately absent — nothing here is repriced.
 */
export function LineItemRowReadOnly({
  displayName,
  sku,
  thumbnailUrl,
  unitPrice,
  qty,
  unitsPerBox,
  boxes,
  pieces,
  lineStatus,
  deliveredQty,
  note,
  className,
}: LineItemRowReadOnlyProps) {
  const { stem, anchor } = splitProductName(displayName);
  const boxed = !!unitsPerBox && unitsPerBox > 1;
  const total = computeLineSubtotal({
    unitPrice,
    qty,
    boxes: boxes ?? null,
    pieces: pieces ?? null,
    unitsPerBox: unitsPerBox ?? null,
  });
  const priceText = `$${unitPrice.toFixed(2)}`;
  const qtyPriceLine = boxed
    ? `${formatQtySplit({ qty, boxes, pieces })} · ${priceText} / box of ${unitsPerBox}`
    : `${formatQtySplit({ qty })} × ${priceText}`;

  return (
    <li className={cn("flex items-start gap-3 px-3 py-3", className)}>
      {/* Reserved 40x40 in both cases so a missing image never shifts the row. */}
      <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-surface-raised">
        {thumbnailUrl ? (
          // Presigned storage URL — next/image's optimizer does not apply.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={thumbnailUrl}
            alt=""
            loading="lazy"
            className="h-full w-full object-cover"
            style={{ objectPosition: objectPositionForUrl(thumbnailUrl) }}
          />
        ) : (
          <Package className="h-4 w-4 text-navy/30" aria-hidden />
        )}
      </div>

      <div className="min-w-0 flex-1">
        {/* Stem (family) may clamp; the anchor (flavor / pack) never does. */}
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
            !stem && "line-clamp-3",
          )}
        >
          {anchor}
        </p>
        {sku && <p className="mt-0.5 font-mono text-xs text-navy/60">SKU {sku}</p>}
        <p className="mt-1 text-xs text-navy/70">{qtyPriceLine}</p>
        {deliveredQty != null && deliveredQty < qty && (
          <p className="text-xs text-navy/70">
            {formatQtySplit({ qty: deliveredQty })} of {formatQtySplit({ qty })} delivered
          </p>
        )}
        {note?.trim() && <p className="mt-1 text-xs italic text-navy/70">{note.trim()}</p>}
        {lineStatus && (
          <div className="mt-1.5">
            <Badge status={lineStatus} />
          </div>
        )}
      </div>

      <span className="shrink-0 text-right text-sm font-semibold text-navy">
        ${total.toFixed(2)}
      </span>
    </li>
  );
}
