import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { AnyPaymentMethod, SelectablePaymentMethod } from "../payment-methods";
import type {
  CheckVendorBillDuplicateDto,
  DuplicateVendorBillError,
  DuplicateVendorBillInfo,
  PriorScanSummary,
  UnlinkedItemsError,
  VendorBillStatus,
} from "@routeflow/types";
/**
 * Close-out review (2026-09-05): was a hand-typed local union missing
 * `"OVERDUE"` — now imported from `@routeflow/types`, pinned to the schema by
 * `enum-parity.spec.ts` (see mobile's `apps/mobile/lib/api/vendor-bills.ts`,
 * L-072, for the same fix applied there in wave E).
 */
export type {
  CheckVendorBillDuplicateDto,
  DuplicateVendorBillError,
  DuplicateVendorBillInfo,
  PriorScanSummary,
  UnlinkedItemsError,
  VendorBillStatus,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface VendorBillItem {
  id: string;
  productId?: string;
  product?: { id: string; name: string; sku?: string; unit?: string };
  description: string;
  qty: number;
  unitCost: number;
  total?: number;
  /** Supplier's item code as printed on the line. */
  sku?: string | null;
  /** Units per box/case — when set (>1) `unitCost` is the CASE cost. */
  packSize?: number | null;
  lineTotal?: number | null;
  /** Cumulative quantity received so far (bill denomination). Null on bills
   *  received before per-line tracking — those were fully received. */
  qtyReceived?: number | string | null;
}

export interface VendorBillPayment {
  id: string;
  amount: number;
  /** Display type — BillPayment.method is the full Prisma `PaymentMethod` enum. */
  method: AnyPaymentMethod;
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
  /** Net-terms label as entered on the bill ("Net 30", "Due on Receipt", …).
   *  Persisted verbatim — the server never derives dueDate from it. */
  termsLabel?: string;
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
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    /** DRAFT bills with no items or unlinked items — receiving them won't update costs */
    needsMappingCount?: number;
  };
}

/** Extract the UNLINKED_ITEMS payload from an axios error, if that's what it is. */
export function getUnlinkedItemsError(error: unknown): UnlinkedItemsError | null {
  const data = (error as { response?: { data?: { code?: string } } })?.response?.data;
  return data?.code === "UNLINKED_ITEMS" ? (data as UnlinkedItemsError) : null;
}

/** Extract the DUPLICATE_VENDOR_BILL payload from an axios error, if that's what it is. */
export function getDuplicateVendorBillError(error: unknown): DuplicateVendorBillError | null {
  const data = (error as { response?: { data?: { code?: string } } })?.response?.data;
  return data?.code === "DUPLICATE_VENDOR_BILL" ? (data as DuplicateVendorBillError) : null;
}

/** Lifecycle of an archived scan. DISCARDED is filtered out server-side, so a
 *  re-upload never reports one. */
export type InvoiceScanStatus = "SCANNED" | "POSTED" | "DISCARDED" | "DUPLICATE";

/**
 * What `POST /vendor-bills/scan-invoice` returns on top of the extraction
 * itself. Kept beside the vendor-bill types rather than folded into ScanResult
 * because these fields describe the archive, not the document: `scanId` has to
 * travel back on the create so the bill and the scan it came from are linked.
 */
export interface ScanArchive {
  scanId?: string | null;
  priorScan?: PriorScanSummary | null;
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
  needsMapping?: boolean;
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
  /** Supplier's item code as printed on the line — what matches this line to a
   *  product on the next scan from the same supplier. */
  sku?: string;
  /** Units per box/case, only when the line explicitly printed one. */
  packSize?: number;
  /** Line amount as printed. Evidence from the document, not derived from
   *  qty × unitCost — an operator correction leaves it standing. */
  lineTotal?: number;
}

export interface CreateVendorBillDto {
  supplierId: string;
  purchaseOrderId?: string;
  billDate: string;
  dueDate: string;
  /** Net-terms label as entered on the bill, prefillable from Supplier.defaultTerms.
   *  Persisted verbatim — the client computes dueDate = billDate + days. */
  termsLabel?: string;
  items: CreateVendorBillItem[];
  notes?: string;
  /** Sales tax on the supplier invoice — folded into totalOwed server-side. */
  taxAmount?: number;
  /** Pre-tax total as printed. Stored only; totalOwed still comes from the lines. */
  subtotal?: number;
  /** The scan this bill was keyed from — marks that scan POSTED and links the two. */
  scanId?: string;
  /** The supplier's own invoice number — normalized and stored server-side. */
  supplierInvoiceNumber?: string;
  /** Operator override: record the bill even though it matches an existing one. */
  allowDuplicate?: boolean;
}

export function useCreateVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, CreateVendorBillDto>({
    mutationFn: (dto) => apiClient.post("/vendor-bills", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["vendor-bills"] }),
  });
}

/**
 * Read-only pre-flight of the guard `POST /vendor-bills` enforces, so a client
 * can warn before the operator commits. Needs either the supplier invoice
 * number, or supplier + bill date together; anything less returns no match.
 */
export function useCheckVendorBillDuplicate() {
  return useMutation<
    { duplicate: DuplicateVendorBillInfo | null },
    Error,
    CheckVendorBillDuplicateDto
  >({
    mutationFn: (dto) => apiClient.post("/vendor-bills/check-duplicate", dto).then((r) => r.data),
  });
}

export interface UpdateVendorBillDto {
  id: string;
  supplierId?: string;
  billDate?: string;
  dueDate?: string;
  termsLabel?: string;
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

/** One line of a partial receive: how much arrived, in the line's own
 *  denomination (cases when packSize > 1). Omit `items` to receive everything
 *  still outstanding. */
export interface ReceiveVendorBillLine {
  itemId: string;
  qty: number;
}

export function useReceiveVendorBill() {
  const qc = useQueryClient();
  return useMutation<
    VendorBill,
    Error,
    { id: string; acknowledgeUnlinked?: boolean; items?: ReceiveVendorBillLine[] }
  >({
    mutationFn: ({ id, acknowledgeUnlinked, items }) =>
      apiClient
        .post(`/vendor-bills/${id}/receive`, {
          ...(acknowledgeUnlinked ? { acknowledgeUnlinked } : {}),
          ...(items ? { items } : {}),
        })
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
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
  method: SelectablePaymentMethod;
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
