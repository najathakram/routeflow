"use client";

import * as React from "react";
import dynamic from "next/dynamic";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { closeEmbeddedCheckout, useEmbeddedCheckout } from "@/lib/checkout-embedded";

/**
 * SA-1139: the host sits in every dashboard shell, so the panel (and with it Stripe.js and the React bindings) is
 * a lazy chunk fetched only once a checkout is open. Nothing from Stripe loads or runs at rest.
 */
const EmbeddedCheckoutPanel = dynamic(
  () => import("./EmbeddedCheckoutPanel").then((m) => m.EmbeddedCheckoutPanel),
  { ssr: false },
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
