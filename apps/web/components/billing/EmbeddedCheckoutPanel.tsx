"use client";

import * as React from "react";
import { loadStripe } from "@stripe/stripe-js/pure";
import { EmbeddedCheckout, EmbeddedCheckoutProvider } from "@stripe/react-stripe-js";
import { stripePublishableKey } from "@/lib/checkout-embedded";

/**
 * SA-1139 R4: Stripe's own card form, shown in place as a full-width sheet. Card data lives only in
 * Stripe's frame; this component never sees it. Never nest it inside another iframe.
 * Loaded lazily by the host, and the only file that imports Stripe (the `/pure` entry, which injects nothing
 * until loadStripe is called here).
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
  // loadStripe injects Stripe's script from js.stripe.com; memoised so a re-render never reloads it. A rejection is
  // caught here (it becomes "no Stripe", the failed state below), so Stripe's own provider never holds an unhandled one.
  const stripePromise = React.useMemo(
    () => loadStripe(stripePublishableKey()).catch(() => null),
    [],
  );
  const options = React.useMemo(() => ({ clientSecret, onComplete }), [clientSecret, onComplete]);
  // One state for every way the form can fail to load (script blocked, key missing): one calm line.
  const [status, setStatus] = React.useState<"loading" | "ready" | "failed">("loading");
  React.useEffect(() => {
    let live = true;
    void stripePromise.then((stripe) => {
      if (live) setStatus(stripe ? "ready" : "failed");
    });
    return () => {
      live = false;
    };
  }, [stripePromise]);

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
        {status === "loading" && (
          <p role="status" className="text-sm text-slate-600">
            Loading the payment form…
          </p>
        )}
        {status === "failed" ? (
          <p role="alert" className="text-sm text-slate-700">
            The payment form didn&apos;t load. Nothing was charged.
          </p>
        ) : (
          <EmbeddedCheckoutProvider stripe={stripePromise} options={options}>
            <EmbeddedCheckout />
          </EmbeddedCheckoutProvider>
        )}
      </div>
    </div>
  );
}
