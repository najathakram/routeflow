import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type {
  CheckVendorBillDuplicateDto,
  DuplicateVendorBillError,
  DuplicateVendorBillInfo,
  PriorScanSummary,
  ScanCandidate,
  UnlinkedItemsError,
  VendorBillStatus,
} from "@routeflow/types";

// ─── Types ────────────────────────────────────────────────────────────────────

/**
 * Wave E / imp-10b, L-072: was a hand-typed local union with an invented
 * `"FULL"` value (not a real Prisma value) and no `"OVERDUE"` — now imported
 * from `@routeflow/types`, pinned to the schema by `enum-parity.spec.ts`.
 */
export type {
  CheckVendorBillDuplicateDto,
  DuplicateVendorBillError,
  DuplicateVendorBillInfo,
  PriorScanSummary,
  ScanCandidate,
  UnlinkedItemsError,
  VendorBillStatus,
} from "@routeflow/types";

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
  totalOwed?: number;
  totalPaid?: number;
  notes?: string;
  supplierId?: string;
  supplier?: { id: string; name: string };
  items?: VendorBillItem[];
  createdAt: string;
}

/** One extracted line as the API actually returns it (mirrors web lib/api/invoice-scan.ts). */
export interface ScannedItem {
  extractedName: string;
  qty?: number | null;
  unitCost?: number | null;
  lineTotal?: number | null;
  matchedProductId?: string | null;
  matchedProductName?: string | null;
  confidence: "high" | "medium" | "low" | "none";
  /** Item code / SKU printed on the scanned line, if any (additive). */
  sku?: string | null;
  /** Units per box/case/pack extracted from the line, only when explicit (additive). */
  packSize?: number | null;
  /** Ranked suggestions when the line is unmatched — rendered as tap-to-link chips. */
  candidates?: ScanCandidate[];
}

/** Lifecycle of an archived scan. DISCARDED is filtered out server-side, so a
 *  re-upload never reports one. */
export type InvoiceScanStatus = "SCANNED" | "POSTED" | "DISCARDED" | "DUPLICATE";

/** Header fields as the API actually returns them (`supplier`, `invoiceDate` — not
 * `supplierName`/`billDate`; the old names silently read as undefined). */
export interface ScanResult {
  supplier?: string | null;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  expenseDescription?: string | null;
  expenseCategory?: string | null;
  subtotal?: number | null;
  tax?: number | null;
  total?: number | null;
  notes?: string | null;
  items: ScannedItem[];
  /** The archived scan this extraction belongs to — sent back on create so the
   *  bill and the document it came from are linked. */
  scanId?: string | null;
  /** Set only when these exact bytes were scanned before. */
  priorScan?: PriorScanSummary | null;
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

// isMoneyInvariantError lives in ../vendor-bill-scan (a pure, react-native-free
// module) instead of here, so it stays reachable from the mobile pure-logic
// Jest suite — this file transitively imports react-native via ../api-client
// and can't be pulled into those tests.
export { isMoneyInvariantError } from "../vendor-bill-scan";

/** A DRAFT bill whose receive would skip inventory/cost updates. */
export function billNeedsMapping(bill: VendorBill): boolean {
  return (
    bill.status === "DRAFT" &&
    ((bill.items ?? []).length === 0 || (bill.items ?? []).some((i) => !i.productId))
  );
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useVendorBills(params?: {
  supplierId?: string;
  status?: VendorBillStatus;
  page?: number;
  limit?: number;
  needsMapping?: boolean;
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

export interface CreateVendorBillItemDto {
  productId?: string;
  description: string;
  qty: number;
  unitCost: number;
  /** Supplier's item code as printed on the line — what matches this line to a
   *  product on the next scan from the same supplier. */
  sku?: string;
  /** Units per box/case, only when the line explicitly printed one. */
  packSize?: number;
  /** Line amount as printed, not derived from qty × unitCost. */
  lineTotal?: number;
}

export interface CreateVendorBillDto {
  supplierId?: string;
  purchaseOrderId?: string;
  billDate?: string;
  dueDate?: string;
  items: CreateVendorBillItemDto[];
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

export function useReceiveVendorBill() {
  const qc = useQueryClient();
  return useMutation<VendorBill, Error, { id: string; acknowledgeUnlinked?: boolean }>({
    mutationFn: ({ id, acknowledgeUnlinked }) =>
      apiClient
        .post(`/vendor-bills/${id}/receive`, acknowledgeUnlinked ? { acknowledgeUnlinked } : {})
        .then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["vendor-bills"] });
      qc.invalidateQueries({ queryKey: ["vendor-bills", id] });
      qc.invalidateQueries({ queryKey: ["inventory"] });
      qc.invalidateQueries({ queryKey: ["products"] });
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
  return useMutation<
    void,
    Error,
    { supplierName: string; rawDescription: string; productId?: string }
  >({
    mutationFn: (dto) =>
      apiClient.post("/vendor-bills/product-mappings", dto).then(() => undefined),
  });
}
