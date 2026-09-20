import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { RestrictionStatus, SellingRestrictionListItemDto } from "@routeflow/types";

export type { RestrictionStatus, SellingRestrictionListItemDto } from "@routeflow/types";

/** The API returns at most this many rules per request (LIST_CAP) — and no total. */
export const RULES_LIST_CAP = 500;

export const restrictionRulesKey = (status?: RestrictionStatus) =>
  ["selling-restrictions", "rules", status ?? "ALL"] as const;

/** All the tenant's rules (OPERATOR+ can read), newest first; `status` filters in SQL, before the cap. */
export function useRestrictionRules(status?: RestrictionStatus) {
  return useQuery<SellingRestrictionListItemDto[]>({
    queryKey: restrictionRulesKey(status),
    queryFn: () =>
      apiClient
        .get("/selling-restrictions", { params: status ? { status } : undefined })
        .then((r) => r.data),
  });
}
