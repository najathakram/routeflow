"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { fmt } from "@/lib/formatting";
import { useCounterCustomerCredit } from "@/lib/api/counter-customer-credit";
import {
  COUNTER_CUSTOMER_DEFAULT_TERMS_COPY,
  COUNTER_CUSTOMER_LOAD_FAILED_COPY,
  COUNTER_CUSTOMER_NO_LIMIT_COPY,
  COUNTER_CUSTOMER_OVERDUE_COPY,
  COUNTER_CUSTOMER_OVERDUE_NOTE,
  COUNTER_CUSTOMER_OVER_LIMIT_NOTE,
  type CreditField,
} from "@/lib/counter-customer-credit";

/** A field that is not known: a quiet "…" while its read is loading, "—" once it could not be read. */
function Unknown({ state }: { state: "loading" | "failed" }) {
  return state === "loading" ? (
    <span className="text-navy/40" aria-label="Loading">
      …
    </span>
  ) : (
    <span aria-label="Not available">—</span>
  );
}

function Value<T>({
  field,
  render,
}: {
  field: CreditField<T>;
  render: (value: T) => React.ReactNode;
}) {
  return field.state === "ready" ? <>{render(field.value)}</> : <Unknown state={field.state} />;
}

/**
 * CQ-07: what a picked (account) customer owes and on what terms, right where the clerk picked them. Display only: the
 * overdue flag and the over-limit note never disable Complete (owner ruling 10-07). Nothing shows for the walk-in. Each
 * figure shows only when its own read resolved.
 */
export function CounterCustomerCredit({ customerId }: { customerId: string }) {
  const { view } = useCounterCustomerCredit(customerId);
  const overdue = view.overdue.state === "ready" ? view.overdue.value : 0;

  return (
    <div className="space-y-1" data-testid="counter-customer-credit">
      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <div className="flex gap-1">
          <dt className="text-navy/70">Terms</dt>
          <dd className="font-medium" data-testid="counter-customer-terms">
            <Value
              field={view.terms}
              render={(t) =>
                t === null ? (
                  <Unknown state="failed" />
                ) : t.isDefault ? (
                  <>
                    {t.text}{" "}
                    <span className="font-normal text-navy/70">
                      ({COUNTER_CUSTOMER_DEFAULT_TERMS_COPY})
                    </span>
                  </>
                ) : (
                  t.text
                )
              }
            />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-navy/70">Credit limit</dt>
          <dd className="font-medium" data-testid="counter-customer-limit">
            <Value
              field={view.creditLimit}
              render={(v) => (v === null ? COUNTER_CUSTOMER_NO_LIMIT_COPY : fmt(v))}
            />
          </dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-navy/70">Open balance</dt>
          <dd className="font-medium" data-testid="counter-customer-open-balance">
            <Value field={view.openBalance} render={(v) => fmt(v)} />
          </dd>
        </div>
      </dl>
      {overdue > 0 ? (
        <p
          role="status"
          className={cn(
            "rounded border border-amber-300 bg-amber-50 px-2 py-1 text-sm text-amber-900",
          )}
          data-testid="counter-customer-overdue"
        >
          <span className="font-semibold">
            {COUNTER_CUSTOMER_OVERDUE_COPY} {fmt(overdue)}
          </span>{" "}
          {COUNTER_CUSTOMER_OVERDUE_NOTE}
        </p>
      ) : null}
      {view.overLimitBy > 0 ? (
        <p role="status" className="text-sm text-navy/80" data-testid="counter-customer-over-limit">
          Over the credit limit by {fmt(view.overLimitBy)}. {COUNTER_CUSTOMER_OVER_LIMIT_NOTE}
        </p>
      ) : null}
      {view.loadFailed ? (
        <p
          role="status"
          className="text-sm text-navy/70"
          data-testid="counter-customer-credit-unavailable"
        >
          {COUNTER_CUSTOMER_LOAD_FAILED_COPY}
        </p>
      ) : null}
    </div>
  );
}
