"use client";

import * as React from "react";
import Link from "next/link";
import { ArrowRight, Package, Plus } from "lucide-react";
import { useBuyerShelf, type ShelfEstimate } from "@/lib/api/buyer";
import type { useBuyerCart } from "@/lib/buyer-cart";
import { objectPositionForUrl } from "@/lib/image-focal";
import { QtyStepper } from "./QtyStepper";

/**
 * P5-07: horizontal running-low strip at the top of the shop.
 *
 * Reads the SAME `/buyer/shelf` payload as the Your Shelf page and the
 * dashboard chips (filtering `state === "low" && !snoozed` client-side), so
 * the low list and the suggested quantities are identical across all three
 * surfaces by construction. Quick-add goes to the LOCAL shop cart (the shop's
 * paradigm) at the suggested qty. Hidden when nothing is low.
 */
export function RunningLowStrip({
  sellerSlug,
  cart,
}: {
  sellerSlug: string;
  cart: ReturnType<typeof useBuyerCart>;
}) {
  const { data: shelf } = useBuyerShelf();
  const low = (shelf?.estimates ?? []).filter((e) => e.state === "low" && !e.snoozed);
  if (low.length === 0) return null;

  const addSuggested = (e: ShelfEstimate) =>
    cart.addItem({
      productId: e.productId,
      qty: e.suggestedQty,
      name: e.name,
      unit: e.unit,
      thumbnailUrl: e.imageUrl,
      unitsPerBox: e.unitsPerBox,
      // suggestedQty is already rounded to whole boxes for boxed products.
      boxes: e.unitsPerBox ? Math.max(1, Math.round(e.suggestedQty / e.unitsPerBox)) : undefined,
      pieces: e.unitsPerBox ? 0 : undefined,
    });

  return (
    <div className="mb-4 overflow-hidden rounded-xl border border-danger/30 bg-white">
      <div className="flex items-center justify-between border-b border-danger/20 bg-danger-bg/50 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-navy">Running low</h2>
          <span className="rounded-full bg-danger px-2 py-0.5 text-[10px] font-bold text-white">
            {low.length}
          </span>
        </div>
        <Link
          href={`/buyer/portal/${sellerSlug}/shelf`}
          className="flex items-center gap-1 text-xs font-medium text-danger hover:underline"
        >
          Your Shelf <ArrowRight className="h-3 w-3" />
        </Link>
      </div>
      <div className="flex gap-3 overflow-x-auto p-3 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {low.map((e) => {
          const qty = cart.getItemQty(e.productId);
          return (
            <div
              key={e.productId}
              className="flex w-44 flex-shrink-0 flex-col items-center gap-2 rounded-lg border border-surface-border p-3"
            >
              <div className="flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg bg-surface-raised">
                {e.imageUrl ? (
                  <img
                    src={e.imageUrl}
                    alt=""
                    className="h-full w-full object-cover"
                    style={{ objectPosition: objectPositionForUrl(e.imageUrl) }}
                  />
                ) : (
                  <Package className="h-6 w-6 text-navy/15" />
                )}
              </div>
              <p className="line-clamp-2 text-center text-xs font-medium text-navy">{e.name}</p>
              <p className="text-[11px] text-navy/60">
                Usually {e.suggestedQty} {e.unitsPerBox && e.unitsPerBox > 1 ? "pcs" : e.unit}
              </p>
              {qty > 0 ? (
                <QtyStepper
                  qty={qty}
                  onUpdate={(n) => cart.updateQty(e.productId, n)}
                  onRemove={() => cart.updateQty(e.productId, 0)}
                  size="sm"
                />
              ) : (
                <button
                  onClick={() => addSuggested(e)}
                  className="flex items-center gap-1 rounded-md bg-buyer-500 px-2.5 py-1 text-[11px] font-semibold text-white transition-colors hover:bg-buyer-600"
                >
                  <Plus className="h-3 w-3" /> Add {e.suggestedQty}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
