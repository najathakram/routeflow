import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateFamilyRequest, UpdateFamilyVariantsRequest } from "@routeflow/types";
import { apiClient } from "../api-client";
import { invalidateProductSet } from "./products";

export interface CreateFamilyResult {
  family: { id: string; name: string };
  variants: Array<{ id: string; name?: string }>;
}

/**
 * Create a family and its variants in ONE all-or-nothing call (WS8). A 409 FAMILY_ROWS_CONFLICT lists
 * every conflicting row (see lib/family-conflicts), so the dialog renders its own errors: the global
 * handler's raw-message toast is opted out.
 */
export function useCreateFamily() {
  const qc = useQueryClient();
  return useMutation({
    meta: { localErrorToast: true },
    mutationFn: (req: CreateFamilyRequest): Promise<CreateFamilyResult> =>
      apiClient.post("/products/families", req).then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
  });
}

/** `PATCH /products/:id/variants`: add / update / deactivate rows, all-or-nothing, at most 200. */
export function useUpdateFamilyVariants(familyId: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { localErrorToast: true },
    mutationFn: (req: UpdateFamilyVariantsRequest) =>
      apiClient.patch(`/products/${familyId}/variants`, req).then((r) => r.data),
    onSuccess: () => invalidateProductSet(qc),
  });
}

export interface CodeAvailability {
  available: boolean;
  takenBy?: { productId: string; field: string };
}

/**
 * Advisory only: is this code free? The write is the authority, so a failure here is swallowed
 * (`null`), never surfaced.
 */
export async function checkCodeAvailable(
  code: string,
  excludeProductId?: string,
): Promise<CodeAvailability | null> {
  try {
    const { data } = await apiClient.get("/products/sku-available", {
      params: { code, ...(excludeProductId ? { excludeProductId } : {}) },
    });
    return data as CodeAvailability;
  } catch {
    return null;
  }
}
