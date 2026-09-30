import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * Tenant-configurable price-tier display names (rung-2 config; see `lib/tier-label.ts`
 * `tierLabel()` for the render-time fallback to "Tier N"). Stored as ONE JSON document
 * in SystemConfig under `pricing.tierLabels`, keyed by tier number as a string ("1".."5")
 * — the same shape `tierLabel()` consumes directly, no mapping needed at render sites.
 * GET is OPERATOR + DRIVER (drivers see priced lines too); PATCH is TENANT_ADMIN only.
 * PATCH semantics mirror remittance config: an omitted key is left untouched, an empty
 * string clears it back to the "Tier N" default.
 */
// A plain string-keyed record (NOT `Partial<Record<"1".."5", string>>`): every present
// key already maps to a `string`, so this is directly assignable to `tierLabel()`'s
// `Record<string, string>` parameter under strictNullChecks — a partial-with-optional-
// properties type would make each value `string | undefined` and need a cast there. An
// absent tier is simply an absent key, which an index signature allows without issue.
export type TierLabelsConfig = Record<string, string>;

export function useTierLabels() {
  return useQuery<TierLabelsConfig>({
    queryKey: ["tier-labels"],
    queryFn: () => apiClient.get("/settings/pricing-tier-labels").then((r) => r.data),
    // Labels change rarely — a generous staleTime keeps every render site from
    // refetching on every navigation.
    staleTime: 30 * 60_000,
  });
}

export function useUpdateTierLabels() {
  const qc = useQueryClient();
  return useMutation({
    // The wire PATCH body is `{tier1..tier5}` (apps/api/.../dto/pricing-tier-labels.dto.ts
    // — class-validator needs static field names), NOT the "1".."5"-keyed record GET
    // returns. Translate here so callers (the settings card form) stay in the same
    // "1".."5" shape `tierLabel()` consumes — an omitted key here stays omitted on the
    // wire, so PATCH's undefined-is-untouched semantics are preserved either way.
    mutationFn: (dto: TierLabelsConfig) => {
      const body: Record<string, string> = {};
      for (const [key, value] of Object.entries(dto)) {
        body[`tier${key}`] = value;
      }
      return apiClient.patch("/settings/pricing-tier-labels", body).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tier-labels"] }),
  });
}
