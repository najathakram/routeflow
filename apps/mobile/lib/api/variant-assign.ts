import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { VariantAssignRequest } from "../variant-split-logic";
import type { VariantAssignResult } from "@routeflow/types";
export type { VariantAssignResult } from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────
// Mirrors the response shape documented in the PR-D plan (WP1:
// `InventoryService.assignToVariants`) and `apps/web/lib/api/variant-assign.ts`.
// Wave E / imp-10b R2: the item type (locally `VariantAssignResultRow`) is now
// `VariantAssignResultItem` on `VariantAssignResult` from `@routeflow/types` —
// no local consumer referenced the row type by name, so it is dropped rather
// than aliased.

// ─── Mutation ─────────────────────────────────────────────────────────────────

/**
 * `POST /inventory/variant-assign` — atomically moves stock from a parent
 * product to its variants (paired ADJUSTMENT movements, one shared
 * reference). See `lib/variant-split-logic.ts` for the pure row math that
 * builds the request body.
 */
export function useAssignToVariants() {
  const qc = useQueryClient();
  return useMutation<VariantAssignResult, Error, VariantAssignRequest>({
    mutationFn: (dto) => apiClient.post("/inventory/variant-assign", dto).then((r) => r.data),
    onSuccess: (_result, variables) => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["products", variables.parentProductId] });
      qc.invalidateQueries({ queryKey: ["admin", "products"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}
