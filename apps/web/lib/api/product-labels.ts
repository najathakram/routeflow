import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { LabelCategoryDto, ProductLabelsDto, SetProductLabelRequest } from "@routeflow/types";
export type { LabelCategoryDto, ProductLabelDto, ProductLabelsDto } from "@routeflow/types";

// Restriction-category labels (Lane R step 4) — feed the selling-restrictions engine, not the
// regulated/tracked-category compliance hooks.

const CATEGORIES_KEY = ["product-categories"] as const;

export function useProductCategories(includeArchived = false) {
  return useQuery<LabelCategoryDto[]>({
    queryKey: [...CATEGORIES_KEY, { includeArchived }],
    queryFn: () =>
      apiClient
        .get("/product-categories", { params: includeArchived ? { includeArchived: true } : {} })
        .then((r) => r.data),
  });
}

export function useCreateProductCategory() {
  const qc = useQueryClient();
  return useMutation<LabelCategoryDto, Error, { name: string }>({
    mutationFn: (dto) => apiClient.post("/product-categories", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

export function useUpdateProductCategory() {
  const qc = useQueryClient();
  return useMutation<
    LabelCategoryDto,
    Error,
    { id: string; data: { name?: string; archived?: boolean } }
  >({
    mutationFn: ({ id, data }) =>
      apiClient.patch(`/product-categories/${id}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: CATEGORIES_KEY }),
  });
}

const labelsKey = (productId: string) => ["product-labels", productId] as const;

export function useProductLabels(productId: string) {
  return useQuery<ProductLabelsDto>({
    queryKey: labelsKey(productId),
    queryFn: () => apiClient.get(`/products/${productId}/labels`).then((r) => r.data),
  });
}

function useLabelMutation<V>(productId: string, run: (v: V) => Promise<unknown>) {
  const qc = useQueryClient();
  return useMutation<unknown, Error, V>({
    mutationFn: run,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: labelsKey(productId) });
      qc.invalidateQueries({ queryKey: CATEGORIES_KEY });
    },
  });
}

export const useSetProductLabel = (productId: string) =>
  useLabelMutation<{ categoryId: string } & SetProductLabelRequest>(
    productId,
    ({ categoryId, ...body }) => apiClient.put(`/products/${productId}/labels/${categoryId}`, body),
  );

export const useRemoveProductLabel = (productId: string) =>
  useLabelMutation<{ categoryId: string }>(productId, ({ categoryId }) =>
    apiClient.delete(`/products/${productId}/labels/${categoryId}`).then((r) => r.data),
  );
