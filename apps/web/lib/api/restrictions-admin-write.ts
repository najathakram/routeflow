import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  AddRuleTargetsResponse,
  CreateSellingRestrictionRequest,
  RemoveRuleTargetsResponse,
  RuleEditCommitRequest,
  RuleEditPreviewResponse,
  RuleEditRequest,
  RuleTargetsInput,
  SellingRestrictionListItemDto,
} from "@routeflow/types";
import { API_ERROR_CODES } from "@routeflow/types";
import { ownsRuleCodes } from "../restriction-rule-errors";

/**
 * Create a selling-restriction rule (TENANT_ADMIN). No `onError` here on purpose: the API's plain
 * 400/404/409 messages ("A state restriction needs at least one state.", "That category is
 * archived…") reach the user through the app's single global mutation toast — a second inline
 * message would double it. Refreshes every cached rules list (the "selling-restrictions" prefix).
 */
export function useCreateRestriction() {
  const qc = useQueryClient();
  return useMutation<SellingRestrictionListItemDto, Error, CreateSellingRestrictionRequest>({
    mutationFn: (body) => apiClient.post("/selling-restrictions", body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["selling-restrictions"] }),
  });
}

/** Lift a rule now (TENANT_ADMIN). Same single-toast rule as create. */
export function useLiftRestriction() {
  const qc = useQueryClient();
  return useMutation<SellingRestrictionListItemDto, Error, { id: string; reason: string }>({
    mutationFn: ({ id, reason }) =>
      apiClient.post(`/selling-restrictions/${id}/lift`, { reason }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["selling-restrictions"] }),
  });
}

const REFRESH = ["selling-restrictions"] as const;

/**
 * Row 509: add products / labels to a rule. Already-present ids come back in `skippedIds`, not as an
 * error. Refusals (RULE_TARGETS_NOT_FOUND, RULE_TARGET_LIMIT, RULE_NOT_EDITABLE) reach the app's one
 * global toast, in fixed copy.
 */
export function useAddRuleTargets() {
  const qc = useQueryClient();
  return useMutation<AddRuleTargetsResponse, Error, { id: string; targets: RuleTargetsInput }>({
    mutationFn: ({ id, targets }) =>
      apiClient.post(`/selling-restrictions/${id}/targets`, targets).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: REFRESH }),
    // A rule that ended under us: refresh so the page shows it as ended.
    onError: (e) => {
      if (ownsRuleCodes(API_ERROR_CODES.RULE_NOT_EDITABLE)(e))
        void qc.invalidateQueries({ queryKey: REFRESH });
    },
  });
}

/**
 * Remove products / labels from a rule (the history keeps them). The surface renders
 * RULE_NEEDS_A_TARGET itself ("This rule would cover nothing. Lift the rule instead?"), so the global
 * toast skips that one code and speaks for every other refusal.
 */
export function useRemoveRuleTargets() {
  const qc = useQueryClient();
  return useMutation<
    RemoveRuleTargetsResponse,
    Error,
    { id: string; targets: RuleTargetsInput; reason?: string }
  >({
    mutationFn: ({ id, targets, reason }) => {
      const note = reason?.trim();
      return apiClient
        .post(`/selling-restrictions/${id}/targets/remove`, {
          ...targets,
          ...(note ? { reason: note } : {}),
        })
        .then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: REFRESH }),
    onError: (e) => {
      if (ownsRuleCodes(API_ERROR_CODES.RULE_NOT_EDITABLE)(e))
        void qc.invalidateQueries({ queryKey: REFRESH });
    },
    meta: { localErrorToast: ownsRuleCodes(API_ERROR_CODES.RULE_NEEDS_A_TARGET) },
  });
}

/** Dry-run an edit: which fields tighten or loosen the rule, and how many open orders it affects. Writes nothing. */
export function useRuleEditPreview() {
  return useMutation<RuleEditPreviewResponse, Error, { id: string; body: RuleEditRequest }>({
    mutationFn: ({ id, body }) =>
      apiClient.post(`/selling-restrictions/${id}/edit-preview`, body).then((r) => r.data),
  });
}

/**
 * Commit an edit that was previewed. The dialog renders RULE_STALE and RULE_IMPACT_CHANGED itself
 * (a Reload banner; an automatic fresh preview), so the global toast skips those two codes.
 */
export function useEditRule() {
  const qc = useQueryClient();
  return useMutation<
    SellingRestrictionListItemDto,
    Error,
    { id: string; body: RuleEditCommitRequest }
  >({
    mutationFn: ({ id, body }) =>
      apiClient.put(`/selling-restrictions/${id}`, body).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: REFRESH }),
    onError: (e) => {
      if (ownsRuleCodes(API_ERROR_CODES.RULE_NOT_EDITABLE)(e))
        void qc.invalidateQueries({ queryKey: REFRESH });
    },
    meta: {
      localErrorToast: ownsRuleCodes(
        API_ERROR_CODES.RULE_STALE,
        API_ERROR_CODES.RULE_IMPACT_CHANGED,
      ),
    },
  });
}
