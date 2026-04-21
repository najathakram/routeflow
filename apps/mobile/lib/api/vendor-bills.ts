import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VendorBillStatus = "DRAFT" | "RECEIVED" | "PARTIAL" | "FULL" | "VOID";

export interface VendorBillItem {
  id: string;
  description: string;
  productId?: string;
  product?: { id: string; name: string };
  qty: number;
  unitCost: number;
  lineTotal: number;
}

export interface VendorBill {
  id: string;
  billNumber?: string;
  status: VendorBillStatus;
  billDate?: string;
  dueDate?: string;
  totalAmount?: number;
  notes?: string;
  supplierId?: string;
  supplier?: { id: string; name: string };
  items?: VendorBillItem[];
  createdAt: string;
}

export interface ScannedItem {
  description: string;
  qty?: number;
  unitCost?: number;
  lineTotal?: number;
  productId?: string;
  productName?: string;
  confidence: "high" | "medium" | "low" | "none";
}

export interface ScanResult {
  supplierName?: string;
  billDate?: string;
  invoiceNumber?: string;
  subtotal?: number;
  tax?: number;
  total?: number;
  items: ScannedItem[];
  supplierId?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useVendorBills(params?: {
  supplierId?: string;
  status?: VendorBillStatus;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: VendorBill[]; meta: any }>({
    queryKey: ["vendor-bills", params],
    queryFn: () =>
      apiClient.get("/vendor-bills", { params: { limit: 30, ...params } }).then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useVendorBill(id: string) {
  return useQuery<VendorBill>({
    queryKey: ["vendor-bills", id],
    queryFn: () => apiClient.get(`/vendor-bills/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, any>({
    mutationFn: (dto) => apiClient.post("/vendor-bills", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });
}

export function useReceiveVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/vendor-bills/${id}/receive`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useVoidVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/vendor-bills/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useScanInvoice() {
  return useMutation<ScanResult, Error, FormData>({
    mutationFn: (formData) =>
      apiClient
        .post("/vendor-bills/scan-invoice", formData, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 90_000,
        })
        .then((r) => r.data),
  });
}

export function useSaveProductMapping() {
  return useMutation<void, Error, { supplierName: string; rawDescription: string; productId?: string }>({
    mutationFn: (dto) =>
      apiClient.post("/vendor-bills/product-mappings", dto).then(() => undefined),
  });
}
