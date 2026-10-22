"use client";

import * as React from "react";
import { Package } from "lucide-react";
import { Badge, cn } from "@routeflow/ui/web";
import { computeLineSubtotal } from "@routeflow/pricing";
import { BACKORDER_TAG_LABEL, lineBackorderPieces } from "@routeflow/types";
import { invoiceLineQtyText, isUnitLine } from "@/lib/invoice-line-unit";
import { formatMoney } from "@/lib/format";
import { unitPriceNote } from "@/lib/line-unit-price-note";
import type { OrderItem } from "@/lib/api/orders";
import { orderLineName } from "@/lib/product-display";
import { RestrictionOverrideNote } from "@/components/RestrictionOverrideNote";
import { displayLineStatus } from "./line-status";
import { ComponentSubLines } from "@/components/ComponentSubLines";

/**
 * Below md each `<tr role="row">` re-flows into a stacked card (row 508): product full width, then Qty,
 * Unit Price, Line Total and Status as labelled pairs (the label is the cell's `data-label`,
 * painted by `before:`), because the 5-column table ran Line Total / Status past a 390px
 * screen. Every class below is `max-md:`-scoped, so from md up the table is untouched.
 */
const CARD_CELL =
  "max-md:block max-md:p-0 max-md:text-left max-md:before:mb-0.5 max-md:before:block max-md:before:text-xs max-md:before:font-medium max-md:before:text-navy/70 max-md:before:content-[attr(data-label)]";

/**
 * The order-detail line list (read-only table). Extracted VERBATIM from `orders/[id]/page.tsx`
 * (the 163 KB page) as a behaviour-identical prefactor for the order-ui-redesign card list;
 * the markup below is the page's own, with `order.lineItems` / `order.status` renamed to the
 * `lineItems` / `orderStatus` props.
 */
export function OrderLineItemsTable({
  lineItems,
  orderStatus,
  total,
}: {
  lineItems: OrderItem[];
  orderStatus: string;
  total: number;
}) {
  return (
    <div className="-mx-6 -mb-6 overflow-x-auto">
      <table role="table" className="w-full text-sm max-md:block">
        <thead
          role="rowgroup"
          className="border-b border-surface-border bg-surface-raised max-md:sr-only"
        >
          <tr role="row">
            <th role="columnheader" className="eyebrow-label px-6 py-2.5 text-left">
              Product
            </th>
            <th role="columnheader" className="eyebrow-label px-4 py-2.5 text-right">
              Qty
            </th>
            <th role="columnheader" className="eyebrow-label px-4 py-2.5 text-right">
              Unit Price
            </th>
            <th role="columnheader" className="eyebrow-label px-4 py-2.5 text-right">
              Line Total
            </th>
            <th role="columnheader" className="eyebrow-label px-6 py-2.5 text-left">
              Status
            </th>
          </tr>
        </thead>
        <tbody
          role="rowgroup"
          className="divide-y divide-surface-border max-md:block max-md:divide-y-0 max-md:space-y-3 max-md:px-3 max-md:py-3"
        >
          {lineItems.map((li) => (
            <tr
              role="row"
              key={li.id}
              className={cn(
                "hover:bg-surface-raised",
                "max-md:grid max-md:grid-cols-2 max-md:gap-x-3 max-md:gap-y-3 max-md:rounded-lg max-md:bg-white max-md:p-3 max-md:ring-1 max-md:ring-surface-border",
                li.status === "CANCELLED" && "opacity-50",
              )}
            >
              <td role="cell" className="px-6 py-3 max-md:col-span-2 max-md:block max-md:p-0">
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-surface-raised">
                    <Package className="h-4 w-4 text-navy/30" />
                  </div>
                  <div className="min-w-0">
                    <span
                      className={cn(
                        "font-medium text-navy max-md:break-words",
                        li.status === "CANCELLED" && "line-through",
                      )}
                    >
                      {orderLineName(li) ?? "Custom item"}
                    </span>
                    {lineBackorderPieces(li, orderStatus) > 0 && (
                      <span
                        data-testid="line-backorder-tag"
                        title={`${lineBackorderPieces(li, orderStatus)} pcs sold past stock`}
                        className="ml-2 rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200"
                      >
                        {BACKORDER_TAG_LABEL}
                      </span>
                    )}
                    {li.notes && (
                      <p className="mt-0.5 whitespace-pre-line text-xs italic text-navy/60">
                        {li.notes}
                      </p>
                    )}
                    <ComponentSubLines components={li.components} />
                    <RestrictionOverrideNote line={li} />
                  </div>
                  {!li.productId && (
                    <span className="rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200 max-md:shrink-0">
                      Custom
                    </span>
                  )}
                </div>
              </td>
              <td
                role="cell"
                data-label="Qty"
                className={cn("px-4 py-3 text-right text-navy/70", CARD_CELL)}
              >
                {li.boxes != null || li.pieces != null ? (
                  <span title={isUnitLine(li) ? undefined : `${Number(li.qty)} pcs total`}>
                    {/* B653: a named-unit line (Case, Pallet…) shows ITS label via the ONE shared
                        formatter, never the generic "boxes"; a pack line is byte-identical. */}
                    {invoiceLineQtyText(li)}
                  </span>
                ) : (
                  <span className="mono">{invoiceLineQtyText(li)}</span>
                )}
                {/* BUY_N_GET_M: name the free units, or the reduced line
                    total reads as a pricing error. */}
                {Number(li.promoFreeUnits ?? 0) > 0 && (
                  <p className="mt-0.5 text-[10px] font-medium text-amber-700">
                    {Number(li.promoFreeUnits)} free
                  </p>
                )}
              </td>
              <td
                role="cell"
                data-label="Unit Price"
                className={cn("px-4 py-3 text-right", CARD_CELL)}
              >
                <div className="flex flex-col items-end gap-0.5 max-md:items-start">
                  {li.priceType === "SPECIAL" ? (
                    <>
                      <span className="strike text-xs">{formatMoney(li.originalPrice)}</span>
                      <span className="money text-emerald-600">{formatMoney(li.unitPrice)}</span>
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                        Special
                      </span>
                    </>
                  ) : li.priceType === "MANUAL" &&
                    li.originalPrice != null &&
                    Number(li.unitPrice) > Number(li.originalPrice) ? (
                    <>
                      {/* Upsell: sold above list. Operator-only green badge;
                          no strikethrough — the base is redacted before the
                          customer ever sees this line. */}
                      <span className="money text-emerald-600">{formatMoney(li.unitPrice)}</span>
                      <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                        Upsell
                      </span>
                    </>
                  ) : (li.priceType === "DISCOUNTED" ||
                      li.priceType === "MANUAL" ||
                      li.priceType === "PROMO") &&
                    li.originalPrice != null ? (
                    <>
                      <span className="strike text-xs">{formatMoney(li.originalPrice)}</span>
                      <span className="money text-amber-600">{formatMoney(li.unitPrice)}</span>
                      <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                        {li.priceType === "MANUAL"
                          ? "Adjusted"
                          : li.priceType === "PROMO"
                            ? "Promo"
                            : "Discounted"}
                      </span>
                    </>
                  ) : (
                    <span className="money text-navy/70">{formatMoney(li.unitPrice)}</span>
                  )}
                  {(() => {
                    const note = unitPriceNote({
                      unitPrice: li.unitPrice,
                      unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox,
                      unitLabel: li.unitLabel,
                      pieces: li.pieces,
                    });
                    return note ? (
                      <span className="text-xs text-navy/60" data-testid="line-unit-price-unit">
                        {note.text}
                      </span>
                    ) : null;
                  })()}
                </div>
              </td>
              <td
                role="cell"
                data-label="Line Total"
                className={cn("px-4 py-3 text-right", CARD_CELL)}
              >
                {li.status === "CANCELLED" ? (
                  <span className="text-navy/40">—</span>
                ) : (
                  <span className="money text-navy">
                    {formatMoney(
                      li.subtotal != null
                        ? Number(li.subtotal)
                        : computeLineSubtotal({
                            unitPrice: Number(li.unitPrice),
                            qty: Number(li.qty),
                            boxes: li.boxes ?? null,
                            pieces: li.pieces ?? null,
                            // Snapshot upb, never the live product.
                            unitsPerBox: li.unitsPerBox ?? li.product?.unitsPerBox ?? null,
                            // BUY_N_GET_M snapshot, or the fallback bills
                            // a free-units line at full price.
                            freeUnits: Math.max(0, Math.trunc(Number(li.promoFreeUnits ?? 0) || 0)),
                          }),
                    )}
                  </span>
                )}
              </td>
              <td role="cell" data-label="Status" className={cn("px-6 py-3", CARD_CELL)}>
                <Badge status={displayLineStatus(li, orderStatus)} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot role="rowgroup" className="border-t-2 border-surface-border max-md:block">
          <tr
            role="row"
            className="max-md:flex max-md:items-center max-md:justify-between max-md:px-6 max-md:py-3"
          >
            <td
              role="cell"
              colSpan={3}
              className="px-6 py-3 text-right text-sm font-semibold text-navy max-md:block max-md:p-0"
            >
              Order Total
            </td>
            <td role="cell" className="px-4 py-3 text-right max-md:block max-md:p-0">
              <span className="money text-[15px] font-semibold text-navy">
                {formatMoney(total)}
              </span>
            </td>
            <td role="cell" className="max-md:hidden" />
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
