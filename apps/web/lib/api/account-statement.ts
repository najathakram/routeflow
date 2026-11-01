import { useQuery } from "@tanstack/react-query";
import type { AccountStatement } from "@routeflow/types";
import { apiClient } from "../api-client";
import { useOptionalAuth } from "../auth-context";
import { deniedGroupsOf, useMyPermissions } from "./my-permissions";
import { mayOpenStatement } from "../account-statement-display";

/**
 * SA-1078 / W-1096: the one "Open balance" read behind the statement sheet. The key extends the customer statement's own
 * (`["customers", id, "statement"]`), so every existing invalidation of that key hits this read by prefix and the sheet
 * and the tile behind it never disagree after a payment.
 */
export const accountStatementKey = (customerId: string) =>
  ["customers", customerId, "statement", "account"] as const;

export function useAccountStatement(customerId: string | null, enabled = true) {
  const id = customerId ?? "";
  return useQuery<AccountStatement>({
    queryKey: accountStatementKey(id),
    queryFn: () => apiClient.get(`/customers/${id}/account-statement`).then((r) => r.data),
    enabled: enabled && !!id,
  });
}

/**
 * SA-1078 PR-3: the statement as a PDF. The server renders it fresh and answers with a signed URL (no JWT needed to open
 * it). `fetchPdfBlob` picks the right transport for the bytes; touch devices open the URL itself.
 */
export async function fetchAccountStatementPdfUrl(customerId: string): Promise<string> {
  const { url } = await apiClient
    .get<{ url: string }>(`/customers/${customerId}/account-statement/pdf`)
    .then((r) => r.data);
  return url;
}

/**
 * Whether this signed-in person may open the sheet. The server stays the authority (`FINANCE|CUSTOMERS`); this only decides
 * whether a figure is offered as a button. An operator whose permission read has not answered gets the plain figure, never
 * a button that might 403.
 */
export function useMayOpenStatement(): boolean {
  const user = useOptionalAuth()?.user;
  const isOperator = user?.role === "OPERATOR";
  const perms = useMyPermissions(user?.id, { enabled: isOperator });
  return mayOpenStatement(user?.role, isOperator ? deniedGroupsOf(perms.data) : [], {
    permissionsKnown: !isOperator || perms.data !== undefined,
  });
}
