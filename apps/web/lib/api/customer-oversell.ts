import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { PoliciesResponse } from "@routeflow/types";

/**
 * A customer's own out-of-stock-ordering setting: the CUSTOMER-scope row of the existing
 * `orders.buyerOversell` policy (GET /policies is OPERATOR; PUT / DELETE /policies/:key are
 * TENANT_ADMIN, reason required). No second store: this reads and writes the same policy rows the
 * server's `resolveOversellAllowed` resolves, and only the exact value "backorder" ever means allow.
 */
export const OVERSELL_POLICY_KEY = "orders.buyerOversell";
const POLICIES_KEY = ["policies"] as const;

export type OversellOverride = "inherit" | "allow" | "deny";
export type OversellDecision = "allow" | "deny";

export interface CustomerOversellView {
  /** The business-wide setting (the default is "off" = deny). */
  tenant: OversellDecision;
  /** The customer's own choice; "inherit" = no CUSTOMER row. */
  override: OversellOverride;
  /** The customer has their own setting AND it is not what the business setting says. */
  differs: boolean;
}

const decide = (value: unknown): OversellDecision => (value === "backorder" ? "allow" : "deny");

/** Pure: read the customer's view out of GET /policies. `null` while there is nothing to read. */
export function customerOversellView(
  res: PoliciesResponse | undefined,
  customerId: string,
): CustomerOversellView | null {
  const entry = res?.policies.find((p) => p.key === OVERSELL_POLICY_KEY);
  if (!entry) return null;
  const tenantRow = entry.active.find((r) => r.scopeType === "TENANT");
  // The server skips a CUSTOMER row whose value is not a known mode (it falls through to the business
  // setting), so such a row reads as "inherit" here, never as a made-up "don't allow".
  const customerRow = entry.active.find(
    (r) =>
      r.scopeType === "CUSTOMER" &&
      r.scopeId === customerId &&
      (r.value === "backorder" || r.value === "off"),
  );
  const tenant = decide(tenantRow ? tenantRow.value : entry.default);
  const override: OversellOverride = customerRow ? decide(customerRow.value) : "inherit";
  return { tenant, override, differs: override !== "inherit" && override !== tenant };
}

export function usePolicies() {
  return useQuery<PoliciesResponse>({
    queryKey: POLICIES_KEY,
    queryFn: () => apiClient.get("/policies").then((r) => r.data),
  });
}

/** The fixed audit reason written with a change made on the customer's page. */
export const CUSTOMER_OVERSELL_REASON = "Changed on the customer page";

export function useSetCustomerOversell() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { customerId: string; override: OversellOverride }>({
    mutationFn: ({ customerId, override }) =>
      override === "inherit"
        ? apiClient.delete(`/policies/${OVERSELL_POLICY_KEY}`, {
            params: { scopeType: "CUSTOMER", scopeId: customerId },
            data: { reason: CUSTOMER_OVERSELL_REASON },
          })
        : apiClient.put(`/policies/${OVERSELL_POLICY_KEY}`, {
            scopeType: "CUSTOMER",
            scopeId: customerId,
            value: override === "allow" ? "backorder" : "off",
            reason: CUSTOMER_OVERSELL_REASON,
          }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: POLICIES_KEY });
      void qc.invalidateQueries({ queryKey: ["inventory-settings"] });
    },
  });
}
