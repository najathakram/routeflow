"use client";

import * as React from "react";
import { Loader2 } from "lucide-react";
import { Button, Modal } from "@routeflow/ui/web";
import {
  useBuyerProducts,
  useBuyerPromotions,
  toPromotionRules,
  type BuyerOrderTemplate,
} from "@/lib/api/buyer";
import { liveTemplateItems, priceReorderReview } from "@/lib/buyer-reorder-review";

function fmt(n: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

/** Shown when placing fails. Fixed on purpose: a server message can carry ids or internals. */
export const REORDER_FAILED_COPY =
  "We couldn't place this order. Please try again, or contact your seller.";

interface ReorderReviewSheetProps {
  /** The standing order under review; null = closed. */
  template: BuyerOrderTemplate | null;
  /** Called only from the "Place order" button — nothing is ordered before it. */
  onConfirm: () => void;
  onClose: () => void;
  placing: boolean;
  /** Fixed message shown when placing failed; the sheet stays open so nothing is lost. */
  error?: string | null;
}

/**
 * Review step in front of every standing-order "Reorder": the buyer sees each line (name, qty
 * with unit, line total) and the order total BEFORE a real order is placed. The mounted body
 * owns the catalog/promotion queries, so they only run while a template is actually under review.
 */
export function ReorderReviewSheet({
  template,
  onConfirm,
  onClose,
  placing,
  error,
}: ReorderReviewSheetProps) {
  return (
    <Modal
      open={template != null}
      onClose={() => {
        if (!placing) onClose();
      }}
      title="Review your order"
      className="max-w-lg"
      scroll
    >
      {template && (
        <ReviewBody
          template={template}
          onConfirm={onConfirm}
          onClose={onClose}
          placing={placing}
          error={error}
        />
      )}
    </Modal>
  );
}

function ReviewBody({
  template,
  onConfirm,
  onClose,
  placing,
  error,
}: Omit<ReorderReviewSheetProps, "template"> & { template: BuyerOrderTemplate }) {
  const productIds = React.useMemo(
    () => liveTemplateItems(template).map((i) => i.productId),
    [template],
  );
  // An id filter, never a plain catalog page: a product outside the page would silently price at 0.
  const products = useBuyerProducts(productIds.length > 0 ? { ids: productIds } : { limit: 0 });
  const promotions = useBuyerPromotions();
  const promoRules = React.useMemo(() => toPromotionRules(promotions.data), [promotions.data]);

  const loading = products.isLoading || promotions.isLoading;
  const failed = products.isError || promotions.isError;
  const review = React.useMemo(
    () => priceReorderReview(template, products.data?.data ?? [], promoRules),
    [template, products.data, promoRules],
  );
  const pricedCount = review.lines.length - review.unresolvedCount;
  const ready = !loading && !failed && pricedCount > 0;

  return (
    <div className="space-y-4">
      <p className="text-sm text-navy/70">
        <span className="font-medium text-navy">{template.name}</span> — check the items and total,
        then place your order.
      </p>

      {loading && (
        <p className="flex items-center gap-2 text-sm text-navy/70">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading prices…
        </p>
      )}
      {failed && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          We couldn&apos;t load the prices for this order. Close this and try again.
        </p>
      )}
      {!loading && !failed && review.lines.length === 0 && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          Every item on this standing order is on hold, so there is nothing to order.
        </p>
      )}

      {!loading && !failed && review.lines.length > 0 && pricedCount === 0 && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          None of these items can be priced here, so this order can&apos;t be placed from this
          screen. Please contact your seller.
        </p>
      )}

      {!loading && !failed && review.lines.length > 0 && (
        <>
          <ul className="divide-y divide-surface-border rounded-lg border border-surface-border bg-white">
            {review.lines.map((l) => (
              <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2.5 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-medium text-navy">{l.name}</p>
                  <p className="text-xs text-navy/70">
                    {l.qty} {l.unit}
                    {l.freeUnits > 0 ? ` · ${l.freeUnits} free` : ""}
                  </p>
                </div>
                <span className="shrink-0 tabular-nums font-medium text-navy">
                  {l.lineSubtotal == null ? "Price on confirmation" : fmt(l.lineSubtotal)}
                </span>
              </li>
            ))}
          </ul>
          <div className="space-y-1 text-sm">
            {pricedCount > 0 && (
              <>
                <div className="flex justify-between border-t border-surface-border pt-3">
                  <span className="font-semibold text-navy">Estimated total</span>
                  <span className="text-lg font-bold tabular-nums text-navy">
                    {fmt(review.subtotal)}
                  </span>
                </div>
                <p className="text-xs text-navy/60">
                  Tax is added when the order is placed. Your seller confirms the final total.
                </p>
              </>
            )}
            {review.unresolvedCount > 0 && (
              <p className="text-xs text-navy/60">
                {review.unresolvedCount === 1
                  ? "1 item isn't priced here and is left out of this estimate; it is still on the order."
                  : `${review.unresolvedCount} items aren't priced here and are left out of this estimate; they are still on the order.`}
              </p>
            )}
          </div>
        </>
      )}

      {error && (
        <p role="alert" className="rounded-lg bg-danger-bg px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button variant="secondary" onClick={onClose} disabled={placing}>
          Cancel
        </Button>
        <Button
          className="bg-buyer-500 hover:bg-buyer-600 focus-visible:ring-buyer-500"
          onClick={onConfirm}
          loading={placing}
          disabled={!ready || placing}
        >
          Place order
        </Button>
      </div>
    </div>
  );
}
