import * as React from "react";
import Link from "next/link";
import { SHIPPED_ORDER_MESSAGE } from "@routeflow/types";
import { WriteLink } from "@/lib/read-only-gate";

/**
 * What a customer can do about an order that is with the carrier. Its lines are frozen (SA-696), so
 * there is no change request to offer: the exits are a return, a new order, or the seller.
 */
export function ShippedOrderExits() {
  return (
    <div
      role="note"
      data-testid="shipped-order-exits"
      className="rounded-lg border border-surface-border bg-surface-raised px-4 py-3 text-sm text-navy"
    >
      <p className="font-medium">{SHIPPED_ORDER_MESSAGE}</p>
      <p className="mt-1 text-navy/70">
        You can also{" "}
        <Link href="/returns" className="font-medium text-brand-600 underline">
          start a return
        </Link>{" "}
        or{" "}
        <WriteLink href="/orders?action=new" className="font-medium text-brand-600 underline">
          place a new order
        </WriteLink>
        .
      </p>
    </div>
  );
}
