import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  API_ERROR_CODES,
  type CheckoutStart,
  type PaymentDueShown,
  type PaymentDueView,
} from "@routeflow/types";
import { isPaidReturn } from "../checkout-return";
import { assertCheckoutStartable, followCheckout } from "../checkout-embedded";
import { apiClient } from "../api-client";
import { guardCounterLeave } from "../counter-cart-signal";

/** While a payment is due, re-read at least this often so a payment (made in another tab) clears the banner. */
const POLL_MS = 30_000;
/** A card reminder can stand for weeks: re-read it every 5 minutes, and fast only while a card add is being confirmed. */
const CARD_POLL_MS = 300_000;

/**
 * How often to re-read `GET /billing/payment-due`: 30 s while a payment is due; for a card reminder 5 min, or 30 s
 * while the return from Stripe (`?paid=1`) is present (the card is being confirmed); otherwise not at all.
 */
export function paymentDuePollMs(view: PaymentDueView | undefined, search: string): number | false {
  if (view?.due) return POLL_MS;
  if (view?.cardNeeded) return isPaidReturn(new URLSearchParams(search)) ? POLL_MS : CARD_POLL_MS;
  return false;
}

/**
 * Row 542: `GET /billing/payment-due` (OPERATOR and up). The server decides eligibility, the amount and the period;
 * the banner only prints it. `enabled` mirrors the endpoint's role gate (staff only).
 */
export function usePaymentDue(options?: { enabled?: boolean }) {
  return useQuery<PaymentDueView>({
    queryKey: ["billing", "payment-due"],
    queryFn: () => apiClient.get("/billing/payment-due").then((r) => r.data),
    staleTime: 60_000,
    refetchInterval: (q) =>
      paymentDuePollMs(q.state.data, typeof window === "undefined" ? "" : window.location.search),
    ...options,
  });
}

/** The 409 a second Pay gets while its first checkout session is still open. */
export function isCheckoutAlreadyOpen(err: unknown): boolean {
  return (
    (err as { response?: { data?: { code?: unknown } } } | undefined)?.response?.data?.code ===
    API_ERROR_CODES.CATCHUP_SESSION_OPEN
  );
}

/** Only an https Stripe URL is followed; anything else (a malformed or scripted value) is refused. */
export function safeCheckoutUrl(url: unknown): string | null {
  return typeof url === "string" && url.startsWith("https://") ? url : null;
}

/**
 * `POST /billing/payment-due/pay` (TENANT_ADMIN): opens the Stripe Checkout for the amount due and sends the browser
 * there. Row 542c: the click sends the terms the banner displayed (`shownTermsOf`); the server compares them with its
 * fresh plan and answers a stale quote with 409 PAYMENT_TERMS_CHANGED, creating nothing. The error toast is the
 * app-wide one (fixed copy by code) and the banner is re-read on error. Leaving goes through the counter's leave guard
 * so an open cart is never dropped silently. Only an https URL is followed.
 */
export function usePayPaymentDue() {
  const qc = useQueryClient();
  return useMutation<CheckoutStart, Error, PaymentDueShown | undefined>({
    // A second Pay answers 409 CATCHUP_SESSION_OPEN; the banner words that itself (the shared map says "wait").
    meta: { localErrorToast: isCheckoutAlreadyOpen },
    mutationFn: (shown) =>
      (shown
        ? apiClient.post("/billing/payment-due/pay", { shown })
        : apiClient.post("/billing/payment-due/pay")
      ).then((r) => assertCheckoutStartable(r.data)),
    // A refused pay (409 PAYMENT_NOT_DUE, or PAYMENT_TERMS_CHANGED) means the banner is stale: re-read it on error too.
    onError: () => {
      void qc.invalidateQueries({ queryKey: ["billing", "payment-due"] });
    },
    // SA-1139: embedded opens the panel in place (no leave, so no cart guard); hosted is today's redirect.
    onSuccess: (r) =>
      followCheckout(r, (checkoutUrl) => {
        const url = safeCheckoutUrl(checkoutUrl);
        if (!url) return;
        const go = () => window.location.assign(url);
        if (guardCounterLeave(go)) return;
        go();
      }),
  });
}
