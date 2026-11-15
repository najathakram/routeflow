"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { closeEmbeddedCheckout, useEmbeddedCheckout } from "@/lib/checkout-embedded";

/**
 * The sheet the panel and its two stand-ins share: a full-width page with a Back button. Holds no Stripe code, so the
 * host can show it before the panel's chunk has arrived, or when it never does.
 */
function Sheet({ onBack, children }: { onBack: () => void; children: React.ReactNode }) {
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
        {children}
      </div>
    </div>
  );
}

/** SA-1154: shown while the panel's chunk is on its way. Back closes the checkout, so nobody waits on a dead sheet. */
function PanelLoading() {
  return (
    <Sheet onBack={closeEmbeddedCheckout}>
      <p role="status" className="text-sm text-slate-600">
        Loading the payment form…
      </p>
    </Sheet>
  );
}

/** SA-1154: the panel's chunk failed to load (a deploy moved it, the connection dropped). Nothing was charged. */
function LoadFailedPanel({ onBack }: { onBack: () => void }) {
  return (
    <Sheet onBack={onBack}>
      <p role="alert" className="text-sm text-slate-700">
        The payment form didn&apos;t load. Nothing was charged.
      </p>
    </Sheet>
  );
}

/**
 * SA-1139: the host sits in every dashboard shell, so the panel (and with it Stripe.js and the React bindings) is
 * a lazy chunk fetched only once a checkout is open. Nothing from Stripe loads or runs at rest.
 * SA-1154: a chunk that fails to load lands on {@link LoadFailedPanel}, not on Next's default error page.
 */
const EmbeddedCheckoutPanel = dynamic(
  () =>
    import("./EmbeddedCheckoutPanel")
      .then((m) => m.EmbeddedCheckoutPanel)
      .catch(() => LoadFailedPanel),
  { ssr: false, loading: () => <PanelLoading /> },
);

function OpenCheckout({ clientSecret, returnPath }: { clientSecret: string; returnPath: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  // The subscription state still comes only from the webhook; this just re-reads it. The path is the one the
  // opening flow chose (its hosted twin's return), so a card add never reads as a payment.
  const onComplete = React.useCallback(() => {
    closeEmbeddedCheckout();
    void qc.invalidateQueries({ queryKey: ["billing"] });
    router.push(returnPath);
  }, [qc, router, returnPath]);
  return (
    <EmbeddedCheckoutPanel
      key={clientSecret}
      clientSecret={clientSecret}
      onBack={closeEmbeddedCheckout}
      onComplete={onComplete}
    />
  );
}

/** Mounted once in the dashboard shell; shows the panel while a checkout is open. */
export function EmbeddedCheckoutHost() {
  const open = useEmbeddedCheckout();
  return open ? (
    <OpenCheckout clientSecret={open.clientSecret} returnPath={open.returnPath} />
  ) : null;
}
