"use client";

import * as React from "react";
import { loadStripe } from "@stripe/stripe-js";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { stripePublishableKey } from "@/lib/checkout-embedded";

/**
 * SA-1139 R4: Stripe's own card form, shown in place as a full-width sheet. Card data lives only in
 * Stripe's frame; this component never sees it. Never nest it inside another iframe.
 */
export function EmbeddedCheckoutPanel({
  clientSecret,
  onBack,
  onComplete,
}: {
  clientSecret: string;
  onBack: () => void;
  onComplete: () => void;
}) {
  // loadStripe injects Stripe's script from js.stripe.com; memoised so a re-render never reloads it.
  const stripePromise = React.useMemo(() => loadStripe(stripePublishableKey()), []);
  const options = React.useMemo(() => ({ clientSecret, onComplete }), [clientSecret, onComplete]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-white" role="dialog" aria-label="Payment">
      <div className="mx-auto w-full max-w-3xl p-4 sm:p-6">
        <button
          type="button"
          onClick={onBack}
          className="mb-4 text-sm font-medium text-slate-600 hover:text-slate-900"
        >
          Back
        </button>
        <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
          <EmbeddedCheckout />
        </EmbeddedCheckoutProvider>
      </div>
    </div>
  );
}
