import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import { unwrapListEnvelope } from "../order-templates-logic";
import type { OrderTemplateItem } from "@routeflow/types";
export type { OrderTemplateItem } from "@routeflow/types";

// ─── Types (mirror apps/web/lib/api/order-templates.ts) ─────────────────────────

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

// ─── Queries ────────────────────────────────────────────────────────────────────

export function useOrderTemplates(customerId?: string) {
  return useQuery<OrderTemplate[]>({
    queryKey: ["order-templates", customerId],
    queryFn: () =>
      apiClient
        .get("/order-templates", { params: customerId ? { customerId } : undefined })
        // The staff list endpoint returns the `{data, meta}` ENVELOPE (and has
        // since 2026-03) — the old bare-array assumption made every consumer
        // call `.filter` on the envelope and crash. Unwrap defensively like
        // web's hook does.
        .then((r) => unwrapListEnvelope<OrderTemplate>(r.data)),
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
 * Update a template — `PATCH /:id`. The UpdateDto is all-optional and maps
 * `isActive` both ways, so this one PATCH is both the pause/resume toggle and
 * the header edit (name / ISO daysOfWeek / notes). Unlike recurring-invoices,
 * no dedicated resume endpoint is needed.
 */
export interface UpdateOrderTemplateDto {
  name?: string;
  daysOfWeek?: number[]; // ISO 1–7 (Mon..Sun)
  isActive?: boolean;
  notes?: string;
}

export function useUpdateOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<OrderTemplate, Error, { id: string } & UpdateOrderTemplateDto>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/order-templates/${id}`, dto).then((r) => r.data),
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

// ─── Builder mutations (Wave 4 — per-customer standing-orders surface) ─────────

export interface CreateOrderTemplateDto {
  /** Required for staff callers — the service 400s without it. */
  customerId: string;
  name: string;
  daysOfWeek: number[]; // ISO 1–7 (Mon..Sun)
  notes?: string;
  /** ≥1 item; template items carry NO price — generation prices at order time. */
  items: { productId: string; qty: number; notes?: string }[];
}

export function useCreateOrderTemplate() {
  const qc = useQueryClient();
  return useMutation<OrderTemplate, Error, CreateOrderTemplateDto>({
    mutationFn: (dto) => apiClient.post("/order-templates", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["order-templates"] }),
  });
}

export function useAddTemplateItem() {
  const qc = useQueryClient();
  return useMutation<
    OrderTemplateItem,
    Error,
    { templateId: string; productId: string; qty: number; notes?: string }
  >({
    mutationFn: ({ templateId, ...item }) =>
      apiClient.post(`/order-templates/${templateId}/items`, item).then((r) => r.data),
    onSuccess: (_, { templateId }) => invalidateOrderTemplates(qc, templateId),
  });
}

export function useRemoveTemplateItem() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { templateId: string; itemId: string }>({
    mutationFn: ({ templateId, itemId }) =>
      apiClient.delete(`/order-templates/${templateId}/items/${itemId}`).then((r) => r.data),
    onSuccess: (_, { templateId }) => invalidateOrderTemplates(qc, templateId),
  });
}
