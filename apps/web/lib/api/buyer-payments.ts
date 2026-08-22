"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { buyerApiClient } from "@/lib/buyer-api-client";
import { getStoredActiveSeller } from "@/lib/buyer-auth";

// ─── Types (mirror apps/api/src/payment-requests/payment-requests.service.ts return shapes) ─

/** One open invoice a payment would settle against — mirrors AllocationPreviewLine. */
export interface BuyerPaymentAllocationLine {
  invoiceId: string;
  invoiceNumber: string;
  issueDate: string;
  total: number;
  balanceDue: number;
  /** What a payment would put on this invoice (0 rows are dropped by the API). */
  applied: number;
}

export type BuyerPaymentRequestKind = "CARD" | "CASH";

export type BuyerPaymentRequestStatus =
  | "PENDING"
  /** Claimed by the webhook and writing the InvoicePayment — never cancellable,
   *  always transient (flips to SETTLED in the same handler run). */
  | "SETTLING"
  | "SETTLED"
  | "APPROVED"
  | "REJECTED"
  | "FAILED"
  /** checkout.session.expired flipped a CARD request here — not blocking, the
   *  buyer can start a new request immediately (see MakePaymentPanel). */
  | "EXPIRED"
  | "CANCELLED";

/** One of the buyer's own payment requests (mirrors PaymentRequestsService.toBuyerView). */
export interface BuyerPaymentRequestRow {
  id: string;
  kind: BuyerPaymentRequestKind;
  status: BuyerPaymentRequestStatus;
  amount: number;
  note: string | null;
  reference: string | null;
  createdAt: string;
  decidedAt: string | null;
  failureReason: string | null;
}

/** GET /buyer/payments/context — everything the "Make a payment" panel needs. */
export interface BuyerPaymentContext {
  balanceDue: number;
  cardEnabled: boolean;
  openInvoices: BuyerPaymentAllocationLine[];
  /** PENDING or SETTLING — a buyer can only have one open request at a time
   *  (enforced server-side by a partial unique index that excludes EXPIRED,
   *  so an expired request never blocks starting a new one). When nothing is
   *  open, the API instead returns the buyer's most recent request IF it
   *  EXPIRED in the last 24h and nothing has happened since — not a blocker,
   *  just the notice MakePaymentPanel turns into "your payment link expired /
   *  start again". Older expiries are withheld server-side so an abandoned
   *  Checkout doesn't hide the amount form on every visit thereafter. */
  pendingRequests: BuyerPaymentRequestRow[];
}

/** GET /buyer/payments/preview?amount= — oldest-first allocation preview. */
export interface BuyerPaymentPreview {
  lines: BuyerPaymentAllocationLine[];
  excess: number;
}

const KEY = ["buyer", "payment-context"] as const;

// ─── Queries ────────────────────────────────────────────────────────────────

export function useBuyerPaymentContext() {
  return useQuery<BuyerPaymentContext>({
    queryKey: KEY,
    queryFn: () => buyerApiClient.get("/buyer/payments/context").then((r) => r.data),
    staleTime: 30 * 1000,
    // A5: seller-scoped — a call without X-Tenant-Slug 400s (see useBuyerShelf).
    enabled: !!getStoredActiveSeller(),
  });
}

/** Debounced ~350ms so keystrokes stay responsive; keeps the last preview
 *  visible while a new one loads (`placeholderData`) instead of flashing empty. */
export function useBuyerPaymentPreview(amount: number) {
  const [debounced, setDebounced] = useState(amount);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(amount), 350);
    return () => clearTimeout(t);
  }, [amount]);
  return useQuery<BuyerPaymentPreview>({
    queryKey: ["buyer", "payment-preview", debounced],
    queryFn: () =>
      buyerApiClient
        .get("/buyer/payments/preview", { params: { amount: debounced } })
        .then((r) => r.data),
    enabled: Number.isFinite(debounced) && debounced >= 0.5,
    placeholderData: (prev) => prev,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Start a Stripe Checkout session on the seller's connected account. On
 *  success, callers MUST navigate: `window.location.href = data.url`. */
export function useStartCardPayment() {
  const qc = useQueryClient();
  return useMutation<
    { requestId: string; url: string; amount: number },
    Error,
    { amount: number; fromInvoiceId?: string }
  >({
    mutationFn: (body) => buyerApiClient.post("/buyer/payments/card", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Declare a cash payment for the seller to review. No money moves yet. */
export function useDeclareCashPayment() {
  const qc = useQueryClient();
  return useMutation<
    BuyerPaymentRequestRow,
    Error,
    { amount: number; note?: string; reference?: string; fromInvoiceId?: string }
  >({
    mutationFn: (body) => buyerApiClient.post("/buyer/payments/cash", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}

/** Cancel the buyer's own PENDING request (card or cash). */
export function useCancelPaymentRequest() {
  const qc = useQueryClient();
  return useMutation<{ cancelled: true }, Error, string>({
    mutationFn: (requestId) =>
      buyerApiClient.post(`/buyer/payments/requests/${requestId}/cancel`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
