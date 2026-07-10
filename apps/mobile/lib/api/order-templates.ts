import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/web/lib/api/order-templates.ts) ─────────────────────────

export interface OrderTemplateItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number; // NO price field — order-template items carry no money
  notes?: string;
}

export interface OrderTemplate {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  name: string;
  isActive: boolean; // state is a boolean, not a status enum
  daysOfWeek: number[]; // ISO 1–7 (Mon..Sun) — see lib/order-templates-logic.ts
  notes?: string;
  items: OrderTemplateItem[];
  createdAt: string;
  updatedAt: string;
}

// ─── Queries (list endpoint returns a BARE array, not paginated) ────────────────

export function useOrderTemplates(customerId?: string) {
  return useQuery<OrderTemplate[]>({
    queryKey: ["order-templates", customerId],
    queryFn: () =>
      apiClient
        .get("/order-templates", { params: customerId ? { customerId } : undefined })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useOrderTemplate(id: string) {
  return useQuery<OrderTemplate>({
    queryKey: ["order-templates", id],
    queryFn: () => apiClient.get(`/order-templates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function invalidateOrderTemplates(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["order-templates"] });
  qc.invalidateQueries({ queryKey: ["order-templates", id] });
}

/**
 * Generate an order from the template now. `POST /:id/generate` returns the
 * CREATED Order keyed `id` (or the merged-winner order — the service merges
 * pending orders for the customer) — NOT an OrderTemplate. Type it `{ id }` and
 * navigate to that order (same class of fix as the recurring `/run` +
 * estimates `/convert` hooks; web's hook leaves it `unknown` and dead-ends).
 * Server may 400 ("Every item … needs a license…") when every line is
 * regulated-gated — surface that via the error toast.
 */
export function useGenerateTemplateOrder() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/order-templates/${id}/generate`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["order-templates"] });
      qc.invalidateQueries({ queryKey: ["orders"] });
    },
  });
}

/**
 * Pause/Resume a template — `PATCH /:id { isActive }`. Unlike recurring-invoices
 * (whose whitelist ValidationPipe + required DTO blocked the isActive patch, so
 * resume needed a dedicated endpoint), the order-template UpdateDto is all-optional
 * and update() maps isActive both ways — so the single PATCH is the toggle.
 */
export function useUpdateOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<OrderTemplate, Error, { id: string; isActive: boolean }>({
    mutationFn: ({ id, isActive }) =>
      apiClient.patch(`/order-templates/${id}`, { isActive }).then((r) => r.data),
    onSuccess: (_, { id }) => invalidateOrderTemplates(qc, id),
  });
}

/** Delete a template — `DELETE /:id` hard-deletes (`removeForUser`). Confirm-gated in UI. */
export function useDeleteOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/order-templates/${id}`).then((r) => r.data),
    onSuccess: (_, id) => invalidateOrderTemplates(qc, id),
  });
}

// Not wired (the builder surface — deferred, consistent with the other read+act
// parity screens): POST / (create), POST /:id/items, DELETE /:id/items/:itemId,
// and header-field PATCH beyond the isActive toggle.
