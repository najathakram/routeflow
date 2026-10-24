"use client";

import * as React from "react";
import { cn } from "@routeflow/ui/web";
import { WriteButton } from "@/lib/read-only-gate";
import { BUYER_HINT_COPY, BUYER_QUESTION_COPY, type BuyerKind } from "./counter-buyer-choice";

/**
 * S5: the top of the register. Unanswered, it asks "Who's buying?" with one-tap Walk-in (the customer search sits right
 * under it, in the screen); answered, it names the buyer. "New customer" (row 240) opens the existing customer form: pass
 * `onNewCustomer`; without it the button is not drawn (no dead control).
 */
export function CounterBuyerChoice({
  kind,
  customerName,
  disabled,
  onWalkIn,
  onNewCustomer,
}: {
  kind: BuyerKind;
  customerName?: string;
  disabled: boolean;
  onWalkIn: () => void;
  onNewCustomer?: () => void;
}) {
  const headingId = React.useId();
  const asking = kind === null;
  return (
    <div
      role="group"
      aria-labelledby={headingId}
      className={cn(
        "space-y-2 rounded border p-3",
        asking ? "border-brand-700 bg-brand-50" : "border-transparent p-0",
      )}
      data-testid="counter-buyer-choice"
      data-kind={kind ?? "none"}
    >
      {asking ? (
        <>
          <p id={headingId} className="text-base font-semibold">
            {BUYER_QUESTION_COPY}
          </p>
          <p className="text-sm text-navy/70">{BUYER_HINT_COPY}</p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="min-h-[44px] rounded border border-brand-700 bg-white px-4 text-sm font-medium disabled:opacity-40"
              disabled={disabled}
              onClick={onWalkIn}
            >
              Walk-in
            </button>
            {onNewCustomer ? (
              <WriteButton
                variant="secondary"
                className="min-h-[44px]"
                disabled={disabled}
                onClick={onNewCustomer}
              >
                New customer
              </WriteButton>
            ) : null}
          </div>
        </>
      ) : (
        <div className="flex items-center gap-2 text-sm">
          <span id={headingId} className="font-medium">
            {kind === "customer" && customerName ? customerName : "Walk-in customer"}
          </span>
          {kind === "customer" ? (
            <button
              type="button"
              className="min-h-[44px] text-brand-700 underline disabled:opacity-40"
              disabled={disabled}
              onClick={onWalkIn}
            >
              Use Walk-in customer
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}
