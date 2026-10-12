"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import { useCounterCustomerCredit } from "@/lib/api/counter-customer-credit";
import {
  COUNTER_CUSTOMER_NO_LIMIT_COPY,
  COUNTER_CUSTOMER_OVERDUE_COPY,
  COUNTER_CUSTOMER_OVERDUE_NOTE,
  COUNTER_CUSTOMER_OVER_LIMIT_NOTE,
  COUNTER_CUSTOMER_UNAVAILABLE_COPY,
} from "@/lib/counter-customer-credit";

/**
 * CQ-07: what a picked (account) customer owes and on what terms, right where the clerk picked them. Display only: the
 * overdue flag and the over-limit note never disable Complete (owner ruling 10-07). Nothing shows for the walk-in.
 */
export function CounterCustomerCredit({ customerId }: { customerId: string }) {
  const { view, loading, failed } = useCounterCustomerCredit(customerId);

  if (failed) {
    return (
      <p className="text-sm text-navy/70" data-testid="counter-customer-credit-unavailable">
        {COUNTER_CUSTOMER_UNAVAILABLE_COPY}
      </p>
    );
  }

  const unknown = "—";
  return (
    <div className="space-y-1" data-testid="counter-customer-credit" aria-busy={loading}>
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-navy/70">Terms</dt>
          <dd className="font-medium" data-testid="counter-customer-terms">
            {view.terms ?? unknown}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-navy/70">Credit limit</dt>
          <dd className="font-medium">
            {view.creditLimit === null ? COUNTER_CUSTOMER_NO_LIMIT_COPY : fmt(view.creditLimit)}
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-navy/70">Open balance</dt>
          <dd className="font-medium" data-testid="counter-customer-open-balance">
            {view.openBalance === null ? unknown : fmt(view.openBalance)}
          </dd>
        </div>
      </dl>
      {view.overdue > 0 ? (
        <p
          role="status"
          className={cn(
            "rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900",
          )}
          data-testid="counter-customer-overdue"
        >
          <span className="font-semibold">
            {COUNTER_CUSTOMER_OVERDUE_COPY} {fmt(view.overdue)}
          </span>{" "}
          {COUNTER_CUSTOMER_OVERDUE_NOTE}
        </p>
      ) : null}
      {view.overLimitBy > 0 ? (
        <p role="status" className="text-sm text-navy/80" data-testid="counter-customer-over-limit">
          Over the credit limit by {fmt(view.overLimitBy)}. {COUNTER_CUSTOMER_OVER_LIMIT_NOTE}
        </p>
      ) : null}
    </div>
  );
}
