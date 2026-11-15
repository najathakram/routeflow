"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { closeEmbeddedCheckout, useEmbeddedCheckoutSecret } from "@/lib/checkout-embedded";
import { EmbeddedCheckoutPanel } from "./EmbeddedCheckoutPanel";

/** The same success URL the hosted flow returns to, so the billing page's existing handling runs unchanged. */
export const CHECKOUT_SUCCESS_PATH = "/settings/billing?checkout=success";

function OpenCheckout({ clientSecret }: { clientSecret: string }) {
  const router = useRouter();
  const qc = useQueryClient();
  // The subscription state still comes only from the webhook; this just re-reads it.
  const onComplete = React.useCallback(() => {
    closeEmbeddedCheckout();
    void qc.invalidateQueries({ queryKey: ["billing"] });
    router.push(CHECKOUT_SUCCESS_PATH);
  }, [qc, router]);
  return (
    <EmbeddedCheckoutPanel
      clientSecret={clientSecret}
      onBack={closeEmbeddedCheckout}
      onComplete={onComplete}
    />
  );
}

/** Mounted once in the dashboard shell; shows the panel while a checkout is open. */
export function EmbeddedCheckoutHost() {
  const clientSecret = useEmbeddedCheckoutSecret();
  return clientSecret ? <OpenCheckout clientSecret={clientSecret} /> : null;
}
