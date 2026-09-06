import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { SelectablePaymentMethod } from "../payment-methods";
import type { CustomerComment, CustomerDocument } from "@routeflow/types";
export type { CustomerComment, CustomerDocument } from "@routeflow/types";

export interface Customer {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  notes?: string;
  fulfillPath: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  email?: string;
  mobile?: string;
  customerType?: string;
  displayName?: string;
  salutation?: string;
  firstName?: string;
  lastName?: string;
  taxId?: string;
  isTaxExempt?: boolean;
  taxExemptDocumentKeys?: string[];
  creditLimit?: number;
  currency?: string;
  pricingTier?: number;
  receivables?: number;
  unusedCredits?: number;
  /**
   * Per-customer "this customer is always Net 60" override — one of the same
   * VALID_TERMS values as Settings → Invoicing's tenant default ("Due on
   * Receipt"/"Net 15"/"Net 30"/"Net 45"/"Net 60"), or "" to fall back to the
   * tenant default. Wins over the tenant default in `resolveDefaultTerms()`.
   */
  defaultPaymentTerms?: string;
  /**
   * Per-customer default deposit percent ("50% upfront, remainder on the terms
   * above") — auto-applied (depositDueDate = issue date) to every invoice
   * GENERATED for this customer from an order; a manual invoice's explicit
   * depositPercent still wins. `null`/undefined = no deposit default. Prisma
   * Decimal serializes as a string on the wire.
   */
  defaultDepositPercent?: number | string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContactPerson {
  id: string;
  customerId: string;
  salutation?: string;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  isPrimary: boolean;
  createdAt: string;
}

export interface CustomerTag {
  id: string;
  name: string;
  color: string;
  createdAt: string;
}

export interface IncomeChartData {
  month: string;
  income: number;
  expenses: number;
}

export function useCustomers(params?: {
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
  tag?: string;
  customerType?: string;
  sortBy?: string;
  sortDir?: string;
  /** "1" = only customers holding a license for a regulated category. */
  regulated?: string;
}) {
  return useQuery({
    queryKey: ["customers", params],
    queryFn: () => apiClient.get("/customers", { params }).then((r) => r.data),
  });
}

export function useCustomer(id: string) {
  return useQuery({
    queryKey: ["customers", id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Record<string, unknown>) =>
      apiClient.post("/customers", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.patch(`/customers/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useUpdateCustomerStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      apiClient.patch(`/customers/${id}/status`, { status }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.id] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useCustomerOrders(id: string) {
  return useQuery({
    queryKey: ["customers", id, "orders"],
    queryFn: () => apiClient.get(`/customers/${id}/orders`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useCustomerRoutes(id: string) {
  return useQuery({
    queryKey: ["customers", id, "routes"],
    queryFn: () => apiClient.get(`/customers/${id}/routes`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useAddCustomerAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string; [k: string]: unknown }) =>
      apiClient.post(`/customers/${id}/addresses`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id] }),
  });
}

export function useUpdateCustomerAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      addrId,
      ...data
    }: {
      id: string;
      addrId: string;
      label?: string;
      line1?: string;
      line2?: string;
      city?: string;
      state?: string;
      zip?: string;
      isDefault?: boolean;
      /** BILLING | SHIPPING | DELIVERY — matches the API's UpdateAddressDto. */
      addressType?: string;
    }) => apiClient.patch(`/customers/${id}/addresses/${addrId}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id] }),
  });
}

/**
 * Delete a customer address. The server 409s (ConflictException) when a
 * RouteStop or RouteRunStop still references it — surface that message via
 * toast, don't swallow it. Deleting the primary promotes the oldest
 * remaining address to primary server-side.
 */
export function useDeleteCustomerAddress() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, addrId }: { id: string; addrId: string }) =>
      apiClient.delete(`/customers/${id}/addresses/${addrId}`).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id] }),
  });
}

// ─── Statement ────────────────────────────────────────────────────────────────

/**
 * What the server ACTUALLY sends (getStatementForOperator): UPPERCASE types
 * and `runningBalance`. The old lowercase `type` + `balance` contract never
 * matched a single row — every row badge-rendered as "Payment" with a $NaN
 * balance and the summary tiles computed $0.00.
 *
 * `runningBalance` is NOT a cumulative total: per row it's the invoice's
 * remaining owed (negative), a credit note's unused remainder, or an
 * advance's wallet balance. Payments are folded into invoices, never rows.
 */
export interface StatementTransaction {
  id: string;
  date: string;
  type: "INVOICE" | "CREDIT_NOTE" | "ADVANCE_PAYMENT";
  description: string;
  amount: number;
  runningBalance: number;
  status?: string;
  expiresAt?: string | null;
}

export interface CustomerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  advanceBalance: number;
  pendingOrdersAmount?: number;
  transactions: StatementTransaction[];
}

export function useCustomerStatement(id: string) {
  return useQuery<CustomerStatement>({
    queryKey: ["customers", id, "statement"],
    queryFn: () => apiClient.get(`/customers/${id}/statement`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Advance payments ─────────────────────────────────────────────────────────

export interface AdvancePayment {
  id: string;
  customerId: string;
  amount: number;
  balance: number;
  method: SelectablePaymentMethod;
  reference?: string;
  notes?: string;
  createdAt: string;
}

export function useCustomerAdvancePayments(customerId: string) {
  return useQuery<AdvancePayment[]>({
    queryKey: ["customers", customerId, "advance-payments"],
    queryFn: () => apiClient.get(`/customers/${customerId}/advance-payments`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useCreateAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<
    AdvancePayment,
    Error,
    {
      customerId: string;
      amount: number;
      method: SelectablePaymentMethod;
      reference?: string;
      notes?: string;
    }
  >({
    mutationFn: ({ customerId, ...data }) =>
      apiClient.post(`/customers/${customerId}/advance-payments`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "advance-payments"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "statement"] });
    },
  });
}

// ─── Customer Special Prices ──────────────────────────────────────────────────

export interface CustomerPrice {
  id: string;
  customerId: string;
  productId: string;
  /**
   * A row may now be tier-only, MSRP-only, or both — null means "no tier
   * override" (the customer's default tier applies), not "Tier 0". Every
   * existing reader already falls back with `?? defaultTier`.
   */
  pricingTier: number | null;
  /** Per-customer MSRP override, per PIECE. null = no override (product default applies).
   *  Prisma Decimal serializes as a string on the wire. */
  msrp?: number | string | null;
  notes?: string;
  product?: {
    id: string;
    name: string;
    sku?: string;
    unit: string;
    pricePerUnit: number | string;
    priceTier2?: number | string;
    priceTier3?: number | string;
    priceTier4?: number | string;
    priceTier5?: number | string;
    averageCost?: number | string | null;
    unitsPerBox?: number | null;
    msrp?: number | string | null;
  };
}

export function useCustomerPrices(customerId: string | undefined) {
  return useQuery({
    queryKey: ["customer-prices", customerId],
    queryFn: () => apiClient.get(`/customers/${customerId}/prices`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUpsertCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      ...data
    }: {
      customerId: string;
      productId: string;
      /** Explicit null clears the tier override. Omit the key (don't pass undefined
       *  through) rather than sending it when the caller never touched this field. */
      pricingTier?: number | null;
      /** Explicit null clears the MSRP override. Omit the key entirely (never send
       *  `msrp: undefined`/null) for a tenant without the MSRP addon — the server
       *  403s on any *present* msrp key when flag.msrp is off. */
      msrp?: number | null;
      notes?: string;
    }) => apiClient.post(`/customers/${customerId}/prices`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customer-prices", vars.customerId] });
    },
  });
}

export function useDeleteCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, priceId }: { customerId: string; priceId: string }) =>
      apiClient.delete(`/customers/${customerId}/prices/${priceId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customer-prices", vars.customerId] });
    },
  });
}

/**
 * Delete a customer. Accepts either a bare id (hard-delete attempt — 409s if the
 * customer has financial records) or `{ id, force }` to take the soft-delete
 * branch server-side (mirrors {@link useSoftDeleteCustomer}, which always forces).
 */
export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: string | { id: string; force?: boolean }) => {
      const id = typeof args === "string" ? args : args.id;
      const force = typeof args === "string" ? undefined : args.force;
      return apiClient
        .delete(`/customers/${id}`, force ? { params: { force: "true" } } : undefined)
        .then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

/**
 * Soft-delete a customer (force=true → sets deletedAt, deactivates the user,
 * preserves all financial records). Restorable via {@link useRestoreCustomer} —
 * this is the delete half of the 8-second Undo pattern.
 */
export function useSoftDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.delete(`/customers/${id}`, { params: { force: "true" } }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

/**
 * Restore a soft-deleted customer (the Undo of {@link useSoftDeleteCustomer}).
 * Pass the user's pre-delete `status` so the undo restores exactly (a SUSPENDED
 * customer comes back SUSPENDED, not ACTIVE).
 */
export function useRestoreCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status?: string }) =>
      apiClient.post(`/customers/${id}/restore`, { status }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.id] });
    },
  });
}

export function useCustomerDocuments(customerId: string) {
  return useQuery<CustomerDocument[]>({
    queryKey: ["customers", customerId, "documents"],
    queryFn: () => apiClient.get(`/customers/${customerId}/documents`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUploadCustomerDocuments(customerId: string) {
  const qc = useQueryClient();
  return useMutation<{ uploaded: CustomerDocument[] }, Error, { files: File[]; docType: string }>({
    mutationFn: ({ files, docType }) => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      form.append("docType", docType);
      return apiClient.post(`/customers/${customerId}/documents`, form).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers", customerId, "documents"] }),
  });
}

export function useDeleteCustomerDocument(customerId: string) {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (docId) =>
      apiClient.delete(`/customers/${customerId}/documents/${docId}`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers", customerId, "documents"] }),
  });
}

export function useBatchDeleteCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiClient
        .post("/customers/batch-delete", { ids })
        .then((r) => r.data as { deleted: number; failed: { id: string; reason: string }[] }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useDeleteAllCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete("/customers/all").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

// ─── Tags ────────────────────────────────────────────────────────────────────

export function useCustomerTags() {
  return useQuery<CustomerTag[]>({
    queryKey: ["customer-tags"],
    queryFn: () => apiClient.get("/customers/tags").then((r) => r.data),
  });
}

export function useCreateCustomerTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: { name: string; color?: string }) =>
      apiClient.post("/customers/tags", data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customer-tags"] }),
  });
}

export function useDeleteCustomerTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (tagId: string) => apiClient.delete(`/customers/tags/${tagId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customer-tags"] }),
  });
}

export function useAssignCustomerTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, tagId }: { customerId: string; tagId: string }) =>
      apiClient.post(`/customers/${customerId}/tags`, { tagId }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

export function useRemoveCustomerTag() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, tagId }: { customerId: string; tagId: string }) =>
      apiClient.delete(`/customers/${customerId}/tags/${tagId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

// ─── Contact Persons ─────────────────────────────────────────────────────────

export function useContactPersons(customerId: string) {
  return useQuery<ContactPerson[]>({
    queryKey: ["customers", customerId, "contacts"],
    queryFn: () => apiClient.get(`/customers/${customerId}/contacts`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useAddContactPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      ...data
    }: {
      customerId: string;
      firstName: string;
      lastName?: string;
      email?: string;
      phone?: string;
      mobile?: string;
      salutation?: string;
      isPrimary?: boolean;
    }) => apiClient.post(`/customers/${customerId}/contacts`, data).then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
  });
}

export function useUpdateContactPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      customerId,
      contactId,
      ...data
    }: {
      customerId: string;
      contactId: string;
      [k: string]: unknown;
    }) =>
      apiClient.patch(`/customers/${customerId}/contacts/${contactId}`, data).then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
  });
}

export function useDeleteContactPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, contactId }: { customerId: string; contactId: string }) =>
      apiClient.delete(`/customers/${customerId}/contacts/${contactId}`).then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
  });
}

// ─── Comments ────────────────────────────────────────────────────────────────

export function useCustomerComments(customerId: string) {
  return useQuery<CustomerComment[]>({
    queryKey: ["customers", customerId, "comments"],
    queryFn: () => apiClient.get(`/customers/${customerId}/comments`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useAddCustomerComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, content }: { customerId: string; content: string }) =>
      apiClient.post(`/customers/${customerId}/comments`, { content }).then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "comments"] }),
  });
}

export function useDeleteCustomerComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, commentId }: { customerId: string; commentId: string }) =>
      apiClient.delete(`/customers/${customerId}/comments/${commentId}`).then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "comments"] }),
  });
}

// ─── Income Chart ────────────────────────────────────────────────────────────

export function useCustomerIncomeChart(customerId: string) {
  return useQuery<IncomeChartData[]>({
    queryKey: ["customers", customerId, "income-chart"],
    queryFn: () => apiClient.get(`/customers/${customerId}/income-chart`).then((r) => r.data),
    enabled: !!customerId,
  });
}

// ─── Export ──────────────────────────────────────────────────────────────────

export function useExportCustomers() {
  return useMutation({
    mutationFn: async (params?: Record<string, string>) => {
      const res = await apiClient.get("/customers/export", { params, responseType: "blob" });
      const url = URL.createObjectURL(res.data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "customers.csv";
      a.click();
      URL.revokeObjectURL(url);
    },
  });
}

// ─── Merge ───────────────────────────────────────────────────────────────────

export function useMergeCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ primaryId, secondaryId }: { primaryId: string; secondaryId: string }) =>
      apiClient.post("/customers/merge", { primaryId, secondaryId }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["customers"] }),
  });
}

// ─── Buyer Portal Management ──────────────────────────────────────────────────

export interface PortalStatus {
  status: "NOT_INVITED" | "INVITED" | "ACTIVE" | "PENDING_SELLER_APPROVAL" | "DISCONNECTED";
  inviteMethod?: string;
  inviteExpiresAt?: string | null;
  linkedAt?: string | null;
  disconnectedAt?: string | null;
  disconnectedBy?: string | null;
  buyerAccount?: { id: string; email: string; name: string } | null;
}

export function usePortalStatus(customerId: string) {
  return useQuery<PortalStatus>({
    queryKey: ["customers", customerId, "portal-status"],
    queryFn: () => apiClient.get(`/customers/${customerId}/portal-status`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useSendPortalInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      method,
      overrideEmail,
    }: {
      id: string;
      method: "EMAIL" | "SMS";
      overrideEmail?: string;
    }) =>
      apiClient
        .post(`/customers/${id}/portal-invite`, { method, overrideEmail })
        .then((r) => r.data),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["customers", vars.id, "portal-status"] }),
  });
}

export function useResendPortalInvite() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post(`/customers/${id}/portal-resend`).then((r) => r.data),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ["customers", id, "portal-status"] }),
  });
}

export function useDisconnectPortal() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post(`/customers/${id}/portal-disconnect`).then((r) => r.data),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ["customers", id, "portal-status"] }),
  });
}

// Pending buyer-connect approvals (the query + approve/decline mutations) live in
// lib/api/portal-approvals.ts — one definition, one declared row shape, one cache key.

// ── Tax-exempt document hooks ─────────────────────────────────────────────────

export interface TaxDocument {
  key: string;
  url: string;
}

export function useCustomerTaxDocuments(customerId: string) {
  return useQuery<TaxDocument[]>({
    queryKey: ["customers", customerId, "tax-documents"],
    queryFn: () => apiClient.get(`/customers/${customerId}/tax-documents`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUploadCustomerTaxDocuments(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (files: File[]): Promise<{ uploaded: TaxDocument[] }> => {
      const form = new FormData();
      files.forEach((f) => form.append("files", f));
      return apiClient.post(`/customers/${customerId}/tax-documents`, form).then((r) => r.data);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers", customerId, "tax-documents"] });
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
    },
  });
}

export function useDeleteCustomerTaxDocument(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (key: string): Promise<void> =>
      apiClient
        .delete(`/customers/${customerId}/tax-documents`, { data: { key } })
        .then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers", customerId, "tax-documents"] });
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
    },
  });
}

// ─── Cleanup imported customers ────────────────────────────────────────────────

export interface CleanupPreview {
  toDelete: number;
  toKeep: number;
  buyers: { id: string; businessName: string }[];
}

export function useCleanupPreview() {
  return useQuery<CleanupPreview>({
    queryKey: ["customers", "cleanup-preview"],
    queryFn: () => apiClient.get("/customers/cleanup-preview").then((r) => r.data),
    enabled: false,
    staleTime: 0,
  });
}

export function useDeleteImportedCustomers() {
  const qc = useQueryClient();
  return useMutation<{ deleted: number; preserved: number }>({
    mutationFn: () => apiClient.delete("/customers/cleanup-imported").then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}
