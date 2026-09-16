import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { usePlanFlag } from "./plan-flags";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * A CustomerLink stuck in PENDING_SELLER_APPROVAL — the buyer's sign-in email
 * didn't match the customer record (or its linked user), so `requestSeller`
 * created a request instead of auto-connecting. Drives both the header bell's
 * pinned "Action needed" section (apps/web/app/(dashboard)/layout.tsx) and the
 * banner on the customers list; rows disappear exactly when the seller
 * approves or declines.
 *
 * Shape mirrors `customers.service.listPendingPortalApprovals`: the raw link
 * row plus its relations, plus the flattened identity fields it appends.
 */
export interface PendingPortalApproval {
  id: string;
  customerId: string;
  customer: { id: string; businessName: string; contactName: string; email: string | null };
  buyerAccount: { id: string; email: string; name: string } | null;
  createdAt: string;
  /** Flattened by the API so consumers don't have to reach into the relations. */
  customerName: string;
  buyerName: string | null;
  buyerEmail: string | null;
  requestedAt: string;
}

/** Shared query key — also invalidated from useNotifications.ts on the
 *  `buyer.connect.requested` socket event, and by the approve/decline flow on
 *  the customer detail page, so every consumer stays in sync. */
export const pendingApprovalsKey = ["customers", "pending-portal-approvals"] as const;

// ─── Queries ──────────────────────────────────────────────────────────────────

/**
 * The single definition of this query — the header bell, the customers list
 * banner and the detail page all read through it, so there is exactly one
 * declared row shape for one cache entry.
 *
 * The socket event gives immediacy; this 60s poll is what makes "in the bar
 * until addressed" durable — it's server state, not a localStorage read-flag,
 * so it survives mark-all-read, clear, and localStorage loss.
 */
export function usePendingPortalApprovals(options?: { enabled?: boolean }) {
  // B449 fix-round finding 2: `GET /customers/pending-portal-approvals` is
  // `@RequirePlanFlag("addon.buyer_portal")`, a dark flag every plan except LITE
  // gets a courtesy allow on (plan-flag-policy.ts's DARK_PLAN_FLAGS/ALWAYS_ENFORCED_
  // PLAN_KEYS) — this hook fired unconditionally from BOTH call sites (the header
  // bell on every page, the customers list), so a LITE tenant got a real 403 here on
  // every page load and every 60s poll, regardless of route. Same three-valued rule
  // as everywhere else: resolved -> go by the flag; unresolved -> don't fire yet;
  // fetch failed -> fire (fail open).
  const gate = usePlanFlag("addon.buyer_portal");
  const gateVisible = gate.resolved ? gate.enabled : gate.failed;
  return useQuery<PendingPortalApproval[]>({
    queryKey: pendingApprovalsKey,
    queryFn: () => apiClient.get("/customers/pending-portal-approvals").then((r) => r.data),
    refetchInterval: 60_000,
    enabled: gateVisible && (options?.enabled ?? true),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/** Approve a pending buyer-connect request (PENDING_SELLER_APPROVAL → ACTIVE). */
export function useApprovePortalRequest() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (customerId) =>
      apiClient.post(`/customers/${customerId}/portal-approve`).then((r) => r.data),
    onSuccess: (_d, customerId) => {
      qc.invalidateQueries({ queryKey: pendingApprovalsKey });
      qc.invalidateQueries({ queryKey: ["customers", customerId, "portal-status"] });
    },
  });
}

/** Decline a pending buyer-connect request — deletes the link row, freeing the
 *  customer's one link slot for a future invite. */
export function useDeclinePortalRequest() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, string>({
    mutationFn: (customerId) =>
      apiClient.post(`/customers/${customerId}/portal-decline`).then((r) => r.data),
    onSuccess: (_d, customerId) => {
      qc.invalidateQueries({ queryKey: pendingApprovalsKey });
      qc.invalidateQueries({ queryKey: ["customers", customerId, "portal-status"] });
    },
  });
}
