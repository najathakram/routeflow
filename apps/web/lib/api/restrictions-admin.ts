import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  RestrictionStatus,
  RuleDetailDto,
  SellingRestrictionListItemDto,
} from "@routeflow/types";

export type {
  RestrictionStatus,
  RuleDetailDto,
  SellingRestrictionListItemDto,
} from "@routeflow/types";

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

/** One page of one rule's detail; under the "selling-restrictions" prefix so every write refreshes it. */
export const restrictionRuleKey = (id: string, cursor?: string | null) =>
  ["selling-restrictions", "rule", id, cursor ?? "first"] as const;

/**
 * Row 509: a rule with its active targets, keyset-paged (`cursor` from the previous page's
 * `nextCursor`; none for the first page). The first page also carries the history.
 */
export function useRuleDetail(id: string, cursor?: string | null) {
  return useQuery<RuleDetailDto>({
    queryKey: restrictionRuleKey(id, cursor),
    queryFn: () => fetchRuleDetail(id, cursor),
    enabled: !!id,
  });
}

/** One page of a rule's detail (shared by `useRuleDetail` and a page that holds several pages at once). */
export const fetchRuleDetail = (id: string, cursor?: string | null): Promise<RuleDetailDto> =>
  apiClient
    .get(`/selling-restrictions/${id}`, { params: cursor ? { cursor } : undefined })
    .then((r) => r.data);
