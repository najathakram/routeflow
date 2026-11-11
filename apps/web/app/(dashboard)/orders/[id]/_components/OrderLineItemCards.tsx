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
import { lineDisplayPack } from "@/lib/line-own-pack";
import { displayLineStatus } from "./line-status";
import { SortLinesButton } from "@/components/SortLinesButton";
import { SortableLines, useSortableLine } from "@/components/SortableLines";
import { useOrderLineOrder } from "@/lib/use-order-line-order";

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
export function lineRowProps(
  li: OrderItem,
  orderStatus: string,
  fulfillPath?: string | null,
): LineItemRowReadOnlyProps {
  return {
    displayName: orderLineName(li) ?? "Custom item",
    sku: li.product?.sku ?? null,
    unitPrice: li.unitPrice,
    qty: li.qty,
    // Snapshot pack size first, never the live product (same rule as the table).
    unitsPerBox: lineDisplayPack(li),
    boxes: li.boxes ?? null,
    pieces: li.pieces ?? null,
    // A unit-aware line (units_v1) names its own box level: "3 Cases", never "3 boxes".
    boxLabel: li.unitLabel ?? null,
    subtotal: li.subtotal ?? null,
    freeUnits: li.promoFreeUnits ?? null,
    priceType: li.priceType ?? null,
    originalPrice: li.originalPrice ?? null,
    lineStatus: displayLineStatus(li, orderStatus, fulfillPath) ?? undefined,
    deliveredQty: li.deliveredQty ?? null,
    showDeliveryProgress: DELIVERY_PROGRESS_STATUSES.has(orderStatus),
    note: li.notes ?? null,
    custom: !li.productId,
    components: li.components ?? null,
    backorderPieces: lineBackorderPieces(li, orderStatus),
  };
}

type CardRowProps = LineItemRowReadOnlyProps;

function PlainCardRow(props: CardRowProps & { id: string }) {
  const { id: _id, ...rest } = props;
  return <LineItemRowReadOnly {...rest} />;
}

function SortableCardRow(props: CardRowProps & { id: string }) {
  const { id, ...rest } = props;
  const { setNodeRef, style, handle } = useSortableLine(id);
  return <LineItemRowReadOnly {...rest} leading={handle} rowRef={setNodeRef} rowStyle={style} />;
}

interface CardsProps {
  lineItems: OrderItem[];
  orderStatus: string;
  /** The order's path: a default line on an open PICKUP order shows no status badge (SA-1066 F15). */
  fulfillPath?: string | null;
  total: number;
  /** W-1187: with the order's id and `updatedAt` the lines can be dragged into any order; without them the list is read-only. */
  orderId?: string;
  updatedAt?: string;
}

/**
 * Card-list order-detail lines (order-ui-redesign-spec §3.5, T6) — the `order_ui_v2` replacement
 * for `OrderLineItemsTable`. One `LineItemRowReadOnly` per line, a "N items · $total" summary
 * above, "Show N more items" beyond `COLLAPSE_AFTER`, and the Order Total below, so nothing the
 * table shows is lost while a long name can no longer eat a phone screen.
 */
export function OrderLineItemCards(props: CardsProps) {
  const [expanded, setExpanded] = React.useState(false);
  return props.orderId && props.updatedAt ? (
    <MovableCards {...props} expanded={expanded} setExpanded={setExpanded} />
  ) : (
    <CardsBody
      {...props}
      shown={props.lineItems}
      Row={PlainCardRow}
      expanded={expanded}
      setExpanded={setExpanded}
    />
  );
}

type Expand = { expanded: boolean; setExpanded: React.Dispatch<React.SetStateAction<boolean>> };

function MovableCards(props: CardsProps & Expand) {
  const order = useOrderLineOrder({
    orderId: props.orderId,
    updatedAt: props.updatedAt,
    lineItems: props.lineItems,
    enabled: props.orderStatus !== "CANCELLED",
  });
  // Folded rows are not on screen, so a drop could not land among them: move only with the whole list shown.
  const open = props.expanded || props.lineItems.length <= COLLAPSE_AFTER;
  return (
    <>
      {order.canMove && (
        <div className="flex justify-end pb-2">
          <SortLinesButton onSort={() => void order.sortByName()} />
        </div>
      )}
      <SortableLines lines={order.lines} onMove={order.onMove} enabled={order.canMove && open}>
        <CardsBody {...props} shown={order.shown} Row={SortableCardRow} />
      </SortableLines>
    </>
  );
}

function CardsBody({
  shown,
  Row,
  orderStatus,
  fulfillPath,
  total,
  expanded,
  setExpanded,
}: CardsProps &
  Expand & { shown: OrderItem[]; Row: React.ComponentType<CardRowProps & { id: string }> }) {
  const activeCount = shown.filter((li) => li.status !== "CANCELLED").length;
  const collapsible = shown.length > COLLAPSE_AFTER;
  const visible = collapsible && !expanded ? shown.slice(0, COLLAPSE_AFTER) : shown;
  const hidden = shown.length - visible.length;
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
          // Row 510: the staff-only override note rides INSIDE its own line's row (a footer of the row), never as a
          // second list item between rows.
          <Row
            key={li.id}
            id={li.id}
            className="px-6"
            {...lineRowProps(li, orderStatus, fulfillPath)}
            footer={<RestrictionOverrideNote line={li} />}
          />
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

      {/* r5 Q20: from lg the Summary card sits beside the lines and carries the total; below it this footer does. */}
      <div className="flex items-center justify-between border-t-2 border-surface-border px-6 py-3 lg:hidden">
        <span className="text-sm font-semibold text-navy">Order total</span>
        <span className="money text-[15px] font-semibold text-navy">{formatMoney(total)}</span>
      </div>
    </div>
  );
}
