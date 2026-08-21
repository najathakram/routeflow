import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/api/src/stripe-connect return shapes) ───────────────────

export interface StripeConnectStatus {
  configured: boolean;
  connected: boolean;
  stripeAccountId: string | null;
  chargesEnabled: boolean;
  detailsSubmitted: boolean;
  livemode: boolean;
  connectedAt: string | null;
}

const KEY = ["settings", "stripe-connect"] as const;

// ─── Queries ────────────────────────────────────────────────────────────────

/** `enabled: false` for roles the API rejects (@Roles(OPERATOR)) so they never 403. */
export function useStripeConnectStatus(options?: { enabled?: boolean }) {
  return useQuery<StripeConnectStatus>({
    queryKey: KEY,
    queryFn: () => apiClient.get("/settings/stripe-connect").then((r) => r.data),
    enabled: options?.enabled ?? true,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Kicks off the Stripe OAuth flow — on success, navigate the browser to it. */
export function useStartStripeConnect() {
  return useMutation<{ url: string }, Error, void>({
    mutationFn: () => apiClient.post("/settings/stripe-connect/link").then((r) => r.data),
    onSuccess: (data) => {
      window.location.href = data.url;
    },
  });
}

export function useDisconnectStripe() {
  const qc = useQueryClient();
  return useMutation<{ disconnected: true }, Error, void>({
    mutationFn: () => apiClient.delete("/settings/stripe-connect").then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEY }),
  });
}
