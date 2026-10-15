import { useMutation, useQuery } from "@tanstack/react-query";
import type { PaymentDuePayResult, PaymentDueView } from "@routeflow/types";
import { apiClient } from "../api-client";
import { guardCounterLeave } from "../counter-cart-signal";

/** While a payment is due, re-read at least this often so a payment (made in another tab) clears the banner. */
const POLL_MS = 30_000;

/**
 * Row 542: `GET /billing/payment-due` (OPERATOR and up). The server decides eligibility, the amount and the period;
 * the banner only prints it. `enabled` mirrors the endpoint's role gate (staff only).
 */
export function usePaymentDue(options?: { enabled?: boolean }) {
  return useQuery<PaymentDueView>({
    queryKey: ["billing", "payment-due"],
    queryFn: () => apiClient.get("/billing/payment-due").then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: (q) => (q.state.data?.due ? POLL_MS : false),
    ...options,
  });
}

/** Only an https Stripe URL is followed; anything else (a malformed or scripted value) is refused. */
export function safeCheckoutUrl(url: unknown): string | null {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * `POST /billing/payment-due/pay` (TENANT_ADMIN): opens the Stripe Checkout for the amount due and sends the browser
 * there. Leaving goes through the counter's leave guard so an open cart is never dropped silently. Only an https URL
 * is followed.
 */
export function usePayPaymentDue() {
  return useMutation<PaymentDuePayResult, Error, void>({
    mutationFn: () => apiClient.post("/billing/payment-due/pay").then((r) => r.data),
    onSuccess: (r) => {
      const url = safeCheckoutUrl(r.checkoutUrl);
      if (!url) return;
      const go = () => window.location.assign(url);
      if (guardCounterLeave(go)) return;
      go();
    },
  });
}
