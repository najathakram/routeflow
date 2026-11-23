import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { EstimateTaxBasis } from "../estimate-tax-basis";
import { apiClient } from "../api-client";
import type { Estimate, EstimateStatus } from "@routeflow/types";
import { splitIdAck, type IdWithAck } from "@/lib/api/restriction-warning";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Wave E / imp-10b, L-072 (sibling-sweep find): was a hand-typed local union
 * with a phantom `"EXPIRED"` value the Prisma schema has never had — now
 * imported from `@routeflow/types`, pinned to the schema by `enum-parity.spec.ts`.
 */
export type { Estimate, EstimateItem, EstimateStatus } from "@routeflow/types";

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useEstimates(params?: {
  status?: string;
  search?: string;
  dateFrom?: string;
  dateTo?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<Estimate>>({
    queryKey: ["estimates", params],
    queryFn: () => apiClient.get("/estimates", { params }).then((r) => r.data),
  });
}

export function useEstimate(id: string) {
  return useQuery<Estimate>({
    queryKey: ["estimates", id],
    queryFn: () => apiClient.get(`/estimates/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateEstimateItem {
  /** A draft edit only: the stored line this one re-sends. */
  id?: string;
  productId?: string;
  description: string;
  qty: number;
  unitPrice?: number;
  boxes?: number;
  pieces?: number;
}

export interface CreateEstimateDto {
  customerId: string;
  issueDate?: string;
  expiresAt?: string;
  items: CreateEstimateItem[];
  notes?: string;
  terms?: string;
}

export function useCreateEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, CreateEstimateDto>({
    mutationFn: (dto) => apiClient.post("/estimates", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["estimates"] }),
  });
}

/** PATCH /estimates/:id: edit a DRAFT. Omitted fields keep their value; `items` replaces the lines. */
export type UpdateEstimateDto = Partial<CreateEstimateDto>;

export function useUpdateEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, { id: string; dto: UpdateEstimateDto }>({
    mutationFn: ({ id, dto }) => apiClient.patch(`/estimates/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

/** A SENT or ACCEPTED estimate back to DRAFT, so it can be revised. */
export function useRevertEstimateToDraft() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/revert-to-draft`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useSendEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useAcceptEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/accept`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useDeclineEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/decline`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}

export function useConvertEstimateToInvoice() {
  const qc = useQueryClient();
  // Server returns the created Invoice keyed `id` (B15-NAV) — not `invoiceId`.
  // H5: `taxBasis` is the quote's tax against the tax the invoice was issued with (today's rate); absent on an older API.
  return useMutation<{ id: string; taxBasis?: EstimateTaxBasis }, Error, IdWithAck>({
    mutationFn: (v) => {
      const { id, ack } = splitIdAck(v); // row 510: the new invoice is judged, so a convert can carry an ack
      return (
        ack
          ? apiClient.post(`/estimates/${id}/convert`, ack)
          : apiClient.post(`/estimates/${id}/convert`)
      ).then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

export function useVoidEstimate() {
  const qc = useQueryClient();
  return useMutation<Estimate, Error, string>({
    mutationFn: (id) => apiClient.post(`/estimates/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["estimates"] });
      qc.invalidateQueries({ queryKey: ["estimates", id] });
    },
  });
}
