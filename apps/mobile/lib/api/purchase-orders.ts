import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { PurchaseOrderStatus } from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Wave E / imp-10b, L-072: was a hand-typed local union with `"PARTIALLY_RECEIVED"`
 * where the schema says `PARTIAL` — now imported (aliased to this file's historical
 * local name) from `@routeflow/types`, pinned to the schema by `enum-parity.spec.ts`.
 */
export type POStatus = PurchaseOrderStatus;

export interface POItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string; unitsPerBox?: number | null };
  // Prisma Decimals serialize as numeric strings over JSON — coerce with Number().
  qtyOrdered: number | string;
  qtyReceived: number | string;
  unitCost: number | string;
}

export interface PurchaseOrder {
  id: string;
  poNumber: string;
  status: POStatus;
  supplier?: { id: string; name: string };
  supplierId: string;
  items: POItem[];
  expectedDate?: string;
  notes?: string;
  totalAmount?: number;
  createdAt: string;
}

export interface ReceivePODto {
  // Boxed lines send { boxes, pieces } (server converts to pieces);
  // a bare qtyReceived KEEPS meaning pieces.
  items: { itemId: string; qtyReceived?: number; boxes?: number; pieces?: number }[];
  notes?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function usePurchaseOrders(status?: POStatus) {
  return useQuery<{ data: PurchaseOrder[]; meta: any }>({
    queryKey: ["purchase-orders", status ?? "all"],
    queryFn: () =>
      apiClient
        .get("/inventory/purchase-orders", { params: status ? { status } : undefined })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useOpenPurchaseOrders() {
  // Open = DRAFT or SENT or PARTIAL. Wave E / imp-10b, L-072: this third leg used
  // to send status: "PARTIALLY_RECEIVED", a value the server's PurchaseOrderStatus
  // enum has never had — the request always returned zero rows, so every
  // partially-received PO silently dropped out of the "Open" list.
  return useQuery<{ data: PurchaseOrder[]; meta: any }>({
    queryKey: ["purchase-orders", "open"],
    queryFn: async () => {
      const [draft, sent, partial] = await Promise.all([
        apiClient
          .get("/inventory/purchase-orders", { params: { status: "DRAFT" } })
          .then((r) => r.data),
        apiClient
          .get("/inventory/purchase-orders", { params: { status: "SENT" } })
          .then((r) => r.data),
        apiClient
          .get("/inventory/purchase-orders", { params: { status: "PARTIAL" } })
          .then((r) => r.data),
      ]);
      const data = [...(draft.data ?? []), ...(sent.data ?? []), ...(partial.data ?? [])].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
      return { data, meta: { total: data.length } };
    },
    staleTime: 30_000,
  });
}

export function usePurchaseOrder(id: string) {
  return useQuery<PurchaseOrder>({
    queryKey: ["purchase-orders", id],
    queryFn: () => apiClient.get(`/inventory/purchase-orders/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export interface Supplier {
  id: string;
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export interface SupplierDto {
  name: string;
  contactName?: string;
  phone?: string;
  email?: string;
  notes?: string;
}

export function useSuppliers() {
  return useQuery<Supplier[]>({
    queryKey: ["suppliers"],
    queryFn: () => apiClient.get("/inventory/suppliers").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useCreateSupplier() {
  const qc = useQueryClient();
  return useMutation<Supplier, Error, SupplierDto>({
    mutationFn: (dto) => apiClient.post("/inventory/suppliers", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

export function useUpdateSupplier() {
  const qc = useQueryClient();
  return useMutation<Supplier, Error, { id: string } & Partial<SupplierDto>>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/inventory/suppliers/${id}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["suppliers"] }),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useReceivePO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, { id: string; dto: ReceivePODto }>({
    mutationFn: ({ id, dto }) =>
      apiClient.post(`/inventory/purchase-orders/${id}/receive`, dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
    },
  });
}

export function useCreatePO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, any>({
    mutationFn: (dto) => apiClient.post("/inventory/purchase-orders", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["purchase-orders"] }),
  });
}

export function useSendPO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, string>({
    mutationFn: (id) => apiClient.post(`/inventory/purchase-orders/${id}/send`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", id] });
    },
  });
}

export function useClosePO() {
  const qc = useQueryClient();
  return useMutation<PurchaseOrder, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/inventory/purchase-orders/${id}/close`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders", id] });
    },
  });
}
