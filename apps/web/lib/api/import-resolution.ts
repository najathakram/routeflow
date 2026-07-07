import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IncompleteProduct {
  id: string;
  name: string;
  sku: string;
  unit: string;
  pricePerUnit: string;
  standardCost: string | null;
  unitsPerBox: number | null;
  category: string | null;
  currentStock: string;
  createdAt: string;
}

export interface CompleteSetupInput {
  pricePerUnit?: number;
  unit?: string;
  unitsPerBox?: number;
  category?: string;
}

const KEY = ["import", "resolution"] as const;

// ─── Finish setup (§5 choice 2 tail) ──────────────────────────────────────────

export function useIncompleteProducts() {
  return useQuery<IncompleteProduct[]>({
    queryKey: [...KEY, "incomplete"],
    queryFn: () => apiClient.get("/import/resolution/incomplete").then((r) => r.data),
  });
}

export function useCompleteSetup() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { id: string; data: CompleteSetupInput }>({
    mutationFn: ({ id, data }) =>
      apiClient.patch(`/import/resolution/${id}/complete`, data).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...KEY, "incomplete"] });
      qc.invalidateQueries({ queryKey: ["products"] });
    },
  });
}

// ─── Variant resolution (§5 choices 1–3) — consumed by the batch review flow ──

export function useCreateVariant() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { parentProductId: string; variantName: string; sku?: string }
  >({
    mutationFn: (dto) => apiClient.post("/import/resolution/variant", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["products"] }),
  });
}

export function useCreateBrandNew() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { name: string; sku?: string; cost?: number; unit?: string }
  >({
    mutationFn: (dto) => apiClient.post("/import/resolution/brand-new", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      qc.invalidateQueries({ queryKey: [...KEY, "incomplete"] });
    },
  });
}

export function useMatchExisting() {
  return useMutation<
    { ok: boolean },
    Error,
    { supplierId?: string; rawText: string; productId?: string; expenseCategoryId?: string }
  >({
    mutationFn: (dto) => apiClient.post("/import/resolution/match", dto).then((r) => r.data),
  });
}
