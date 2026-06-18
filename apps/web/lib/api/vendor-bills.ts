import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VendorBillStatus = "DRAFT" | "RECEIVED" | "PARTIAL" | "PAID" | "VOID";

export interface VendorBillItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; sku?: string; unit?: string };
  description: string;
  qty: number;
  unitCost: number;
  total?: number;
}

export interface VendorBillPayment {
  id: string;
  amount: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
  reference?: string;
  notes?: string;
  createdAt: string;
}

export interface VendorBill {
  id: string;
  billNumber: string;
  supplierId: string;
  supplier?: { id: string; name: string; contactName?: string; address?: string };
  purchaseOrderId?: string;
  purchaseOrder?: { id: string; poNumber: string };
  status: VendorBillStatus;
  billDate?: string;
  dueDate?: string;
  receivedDate?: string;
  totalOwed: number;
  totalPaid: number;
  notes?: string;
  items?: VendorBillItem[];
  payments?: VendorBillPayment[];
  createdAt: string;
  updatedAt: string;
}

export interface ProductMapping {
  id: string;
  supplierName: string;
  rawDescription: string;
  productId: string | null;
  product?: { id: string; name: string; sku?: string; unit?: string } | null;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useVendorBills(params?: {
  status?: string;
  supplierId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<PaginatedResponse<VendorBill>>({
    queryKey: ["vendor-bills", params],
    queryFn: () => apiClient.get("/vendor-bills", { params }).then((r) => r.data),
  });
}

export function useVendorBill(id: string) {
  return useQuery<VendorBill>({
    queryKey: ["vendor-bills", id],
    queryFn: () => apiClient.get(`/vendor-bills/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useProductMappings(supplierName: string) {
  return useQuery<ProductMapping[]>({
    queryKey: ["product-mappings", supplierName],
    queryFn: () =>
      apiClient
        .get("/vendor-bills/product-mappings", { params: { supplierName } })
        .then((r) => r.data),
    enabled: !!supplierName,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateVendorBillItem {
  productId?: string;
  description: string;
  qty: number;
  unitCost: number;
}

export interface CreateVendorBillDto {
  supplierId: string;
  purchaseOrderId?: string;
  billDate: string;
  dueDate: string;
  items: CreateVendorBillItem[];
  notes?: string;
}

export function useCreateVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, CreateVendorBillDto>({
    mutationFn: (dto) => apiClient.post("/vendor-bills", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });
}

export interface UpdateVendorBillDto {
  id: string;
  supplierId?: string;
  billDate?: string;
  dueDate?: string;
  notes?: string;
  items?: CreateVendorBillItem[];
}

export function useUpdateVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, UpdateVendorBillDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.patch(`/vendor-bills/${id}`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useReceiveVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, string>({
    mutationFn: (id) => apiClient.post(`/vendor-bills/${id}/receive`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useRevertVendorBillToDraft() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, string>({
    mutationFn: (id) => apiClient.post(`/vendor-bills/${id}/revert-to-draft`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useVoidVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, string>({
    mutationFn: (id) => apiClient.post(`/vendor-bills/${id}/void`).then((r) => r.data),
    onSuccess: (_, id) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export interface RecordVendorBillPaymentDto {
  id: string;
  amount: number;
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
  reference?: string;
  notes?: string;
}

export function useRecordVendorBillPayment() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, RecordVendorBillPaymentDto>({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/vendor-bills/${id}/payments`, data).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
    },
  });
}

export function useDeleteVendorBill() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/vendor-bills/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });
}

export function useBulkDeleteVendorBills() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; skipped: any[] }, Error, string[]>({
    mutationFn: (ids) => apiClient.delete("/vendor-bills", { data: { ids } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });
}

export interface SaveProductMappingDto {
  supplierName: string;
  rawDescription: string;
  productId: string | null;
}

export function useSaveProductMapping() {
  const qc = useQueryClient();
  return useMutation<ProductMapping, Error, SaveProductMappingDto>({
    mutationFn: (dto) => apiClient.post("/vendor-bills/product-mappings", dto).then((r) => r.data),
    onSuccess: (_, { supplierName }) => {
      qc.invalidateQueries({ queryKey: ["product-mappings", supplierName] });
    },
  });
}
