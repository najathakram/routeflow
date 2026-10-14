"use client";

import * as React from "react";
import {
  LineItemRowReadOnly,
  type LineItemRowReadOnlyProps,
} from "@/components/LineItemRowReadOnly";
import { lineBackorderPieces } from "@routeflow/types";
import { formatMoney } from "@/lib/format";
import { RestrictionOverrideNote } from "@/components/RestrictionOverrideNote";
import type { OrderItem } from "@/lib/api/orders";
import { orderLineName } from "@/lib/product-display";
import { displayLineStatus } from "./line-status";

/** Orders with more lines than this collapse behind "Show N more items" (spec §5.1). */
export const COLLAPSE_AFTER = 6;

/** "N of M delivered" is only meaningful once the order is out, part-delivered or done —
 *  `deliveredQty` is 0 (not null) on every undelivered line. Same set the buyer portal uses. */
const DELIVERY_PROGRESS_STATUSES = new Set([
  "OUT_FOR_DELIVERY",
  "PARTIALLY_DELIVERED",
  "DELIVERED",
]);

/** The read-only row's props for one order line — exported so the mapping is testable. */
export function lineRowProps(li: OrderItem, orderStatus: string): LineItemRowReadOnlyProps {
  return {
    displayName: orderLineName(li) ?? "Custom item",
    sku: li.product?.sku ?? null,
    unitPrice: li.unitPrice,
    qty: li.qty,
    // Snapshot pack size first, never the live product (same rule as the table).
    unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
    boxes: li.boxes ?? null,
    pieces: li.pieces ?? null,
    // A unit-aware line (units_v1) names its own box level: "3 Cases", never "3 boxes".
    boxLabel: li.unitLabel ?? null,
    subtotal: li.subtotal ?? null,
    freeUnits: li.promoFreeUnits ?? null,
    priceType: li.priceType ?? null,
    originalPrice: li.originalPrice ?? null,
    lineStatus: displayLineStatus(li, orderStatus),
    deliveredQty: li.deliveredQty ?? null,
    showDeliveryProgress: DELIVERY_PROGRESS_STATUSES.has(orderStatus),
    note: li.notes ?? null,
    custom: !li.productId,
    components: li.components ?? null,
    backorderPieces: lineBackorderPieces(li, orderStatus),
  };
}

/**
 * Card-list order-detail lines (order-ui-redesign-spec §3.5, T6) — the `order_ui_v2` replacement
 * for `OrderLineItemsTable`. One `LineItemRowReadOnly` per line, a "N items · $total" summary
 * above, "Show N more items" beyond `COLLAPSE_AFTER`, and the Order Total below, so nothing the
 * table shows is lost while a long name can no longer eat a phone screen.
 */
export function OrderLineItemCards({
  lineItems,
  orderStatus,
  total,
}: {
  lineItems: OrderItem[];
  orderStatus: string;
  total: number;
}) {
  const [expanded, setExpanded] = React.useState(false);
  const activeCount = lineItems.filter((li) => li.status !== "CANCELLED").length;
  const collapsible = lineItems.length > COLLAPSE_AFTER;
  const visible = collapsible && !expanded ? lineItems.slice(0, COLLAPSE_AFTER) : lineItems;
  const hidden = lineItems.length - visible.length;

  return (
    <div className="-mx-6 -mb-6" data-testid="order-line-cards">
      <p
        className="border-b border-surface-border bg-surface-raised px-6 py-2.5 text-xs font-medium text-navy/70"
        data-testid="order-lines-summary"
      >
        {activeCount} item{activeCount === 1 ? "" : "s"} · {formatMoney(total)}
      </p>

      <ul className="divide-y divide-surface-border">
        {visible.map((li) => (
          <React.Fragment key={li.id}>
            <LineItemRowReadOnly className="px-6" {...lineRowProps(li, orderStatus)} />
            {li.restrictionOverrideReason && (
              <li className="px-6 pb-3 pl-[4.5rem]">
                <RestrictionOverrideNote line={li} />
              </li>
            )}
          </React.Fragment>
        ))}
      </ul>

      {collapsible && (
        <button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((v) => !v)}
          className="w-full border-t border-surface-border px-6 py-3 text-left text-sm font-medium text-brand-600 hover:bg-surface-raised"
        >
          {expanded ? "Show fewer items" : `Show ${hidden} more item${hidden === 1 ? "" : "s"}`}
        </button>
      )}

      <div className="flex items-center justify-between border-t-2 border-surface-border px-6 py-3">
        <span className="text-sm font-semibold text-navy">Order Total</span>
        <span className="money text-[15px] font-semibold text-navy">{formatMoney(total)}</span>
      </div>
    </div>
  );
}
