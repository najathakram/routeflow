import { useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

/**
 * One target in a `POST /inventory/variant-assign` call — either an existing
 * child of the parent (`productId`) or a brand-new variant to create inline
 * (`newVariant`, name only; everything else is inherited server-side).
 * Mirrors `VariantAssignmentDto` (`apps/api/src/inventory/dto/variant-assign.dto.ts`).
 *
 * `qty` is mutually exclusive with `boxes`/`pieces` — send boxes/pieces for a
 * boxed parent so the server's own `normalizeBoxesPieces` stays authoritative
 * on the base-unit total (never re-derive that total client-side and send it
 * as `qty`).
 */
export interface VariantAssignmentInput {
  productId?: string;
  newVariant?: { name: string };
  qty?: number;
  boxes?: number;
  pieces?: number;
  /** Rare per-row override; omit to inherit the parent's averageCost. 4dp. */
  unitCostOverride?: number;
}

export interface VariantAssignRequest {
  parentProductId: string;
  assignments: VariantAssignmentInput[];
  notes?: string;
}

export interface VariantAssignResultItem {
  productId: string;
  variantName: string;
  qty: number;
  unitCost: number;
  created: boolean;
}

export interface VariantAssignResult {
  reference: string;
  parentProductId: string;
  parentRemaining: number;
  assignments: VariantAssignResultItem[];
  movementIds: string[];
}

/**
 * Move stock from a generic parent product atomically into its variants —
 * existing children and/or brand-new ones created inline. Writes one paired
 * set of ADJUSTMENT movements under a shared `VARIANT_ASSIGN-<uuid>`
 * reference (see `InventoryService.assignToVariants`). Shared by every entry
 * point that opens `VariantSplitModal` (product detail, inventory Stock tab,
 * vendor-bill line) so behaviour is identical everywhere.
 */
export function useAssignToVariants() {
  const qc = useQueryClient();
  return useMutation<VariantAssignResult, Error, VariantAssignRequest>({
    mutationFn: (data) => apiClient.post("/inventory/variant-assign", data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
    },
  });
}
