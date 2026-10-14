import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  AddRuleTargetsResponse,
  ProductIdsForFilterResponse,
  RemoveRuleTargetsResponse,
  RulesHoldingResponse,
} from "@routeflow/types";

/**
 * Row 509 PR5: the catalog / product-page side of multi-product rules. Wire shapes are `@routeflow/types`
 * (restrictions-admin.ts, "Row 509"). The plain `*Request` functions exist because a toast's Undo outlives the
 * component that raised it (the selection clears, the dialog unmounts), and a hook's per-call callbacks do not run on
 * an unmounted observer.
 */
const RULES = ["selling-restrictions"] as const;

export interface RuleTargetsBody {
  productIds: string[];
}

/** POST /selling-restrictions/:id/targets - already-present ids come back in `skippedIds`, never as an error. */
export async function addRuleTargetsRequest(
  ruleId: string,
  body: RuleTargetsBody,
): Promise<AddRuleTargetsResponse> {
  const { data } = await apiClient.post(`/selling-restrictions/${ruleId}/targets`, body);
  return data;
}

/** POST /selling-restrictions/:id/targets/remove - ids not in the rule come back in `notInRule`. */
export async function removeRuleTargetsRequest(
  ruleId: string,
  body: RuleTargetsBody & { reason?: string },
): Promise<RemoveRuleTargetsResponse> {
  const { data } = await apiClient.post(`/selling-restrictions/${ruleId}/targets/remove`, body);
  return data;
}

/**
 * Add products to a rule. No global error toast: the chooser renders the coded errors itself (a second message would
 * double it).
 */
export function useAddToRule() {
  const qc = useQueryClient();
  return useMutation<AddRuleTargetsResponse, Error, RuleTargetsBody & { ruleId: string }>({
    meta: { localErrorToast: true },
    mutationFn: ({ ruleId, ...body }) => addRuleTargetsRequest(ruleId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES }),
  });
}

export function useRemoveFromRule(options?: { localErrorToast?: boolean }) {
  const qc = useQueryClient();
  return useMutation<
    RemoveRuleTargetsResponse,
    Error,
    RuleTargetsBody & { ruleId: string; reason?: string }
  >({
    meta: { localErrorToast: options?.localErrorToast ?? true },
    mutationFn: ({ ruleId, ...body }) => removeRuleTargetsRequest(ruleId, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: RULES }),
  });
}

/** The ACTIVE / SCHEDULED rules that hold at least one of these products as a DIRECT target (catalog "Remove from a rule…"). */
export function useRulesHolding(productIds: string[], enabled = true) {
  return useQuery<RulesHoldingResponse["items"]>({
    // The ids are the key: a different selection is a different question.
    queryKey: [...RULES, "holding", productIds.join(",")],
    queryFn: () =>
      apiClient
        .post<RulesHoldingResponse>("/selling-restrictions/holding", { productIds })
        .then((r) => r.data.items),
    enabled: enabled && productIds.length > 0,
  });
}

/** The product list's filters, without the paging (they are the same keys GET /products takes). */
export interface ProductIdsFilters {
  search?: string;
  scanCode?: string;
  category?: string;
  isActive?: boolean;
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  section?: string;
  portalVisible?: boolean;
  includeVariants?: boolean;
}

/**
 * "Select all N matching": the ids behind the CURRENT filters (the server caps at RULE_TARGETS_MAX_PER_REQUEST and says
 * so in `capped`). A mutation, not a query: it is a click-time fetch that must never serve a cached answer.
 */
export function useProductIdsForFilter(filters: ProductIdsFilters) {
  return useMutation<ProductIdsForFilterResponse, Error, void>({
    mutationFn: () =>
      apiClient
        .get<ProductIdsForFilterResponse>("/products/ids", { params: filters })
        .then((r) => r.data),
  });
}

/** The coded error a rule-target write was refused with (`body.code`), plus the 403 a role gate gives. */
export function ruleErrorOf(err: unknown): {
  status: number | null;
  code: string | null;
  field: string | null;
  max: number | null;
} {
  const res = (
    err as {
      response?: { status?: number; data?: { code?: unknown; field?: unknown; max?: unknown } };
    } | null
  )?.response;
  const d = res?.data;
  return {
    status: typeof res?.status === "number" ? res.status : null,
    code: typeof d?.code === "string" ? d.code : null,
    field: typeof d?.field === "string" ? d.field : null,
    max: typeof d?.max === "number" ? d.max : null,
  };
}
