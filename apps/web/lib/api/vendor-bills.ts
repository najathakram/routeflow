import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VendorBillStatus = "DRAFT" | "RECEIVED" | "PARTIAL" | "PAID" | "VOID";

export interface VendorBillItem {
  id: string;
  description: string;
  qty: number;
  unitCost: number;
  total: number;
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

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateVendorBillItem {
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
