import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

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
  creditLimit?: number;
  currency?: string;
  pricingTier?: number;
  receivables?: number;
  unusedCredits?: number;
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

export interface CustomerComment {
  id: string;
  customerId: string;
  userId: string;
  content: string;
  createdAt: string;
}

export interface IncomeChartData {
  month: string;
  income: number;
  expenses: number;
}

export function useCustomers(params?: { search?: string; status?: string; page?: number; limit?: number; tag?: string; customerType?: string; sortBy?: string; sortDir?: string }) {
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
    mutationFn: ({ id, addrId, ...data }: { id: string; addrId: string; [k: string]: unknown }) =>
      apiClient.patch(`/customers/${id}/addresses/${addrId}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id] }),
  });
}

// ─── Statement ────────────────────────────────────────────────────────────────

export interface StatementTransaction {
  date: string;
  type: "invoice" | "payment" | "credit_note" | "advance";
  description: string;
  amount: number;
  balance: number;
  invoiceId?: string;
  invoiceNumber?: string;
}

export interface CustomerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  advanceBalance: number;
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
  method: "CASH" | "CHECK" | "ACH" | "OTHER";
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
  return useMutation<AdvancePayment, Error, { customerId: string; amount: number; method: string; reference?: string; notes?: string }>({
    mutationFn: ({ customerId, ...data }) =>
      apiClient.post(`/customers/${customerId}/advance-payments`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "advance-payments"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "statement"] });
    },
  });
}

export function useApplyAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<unknown, Error, { customerId: string; advancePaymentId: string; invoiceId: string; amount?: number }>({
    mutationFn: ({ customerId, advancePaymentId, ...data }) =>
      apiClient.post(`/customers/${customerId}/advance-payments/${advancePaymentId}/apply`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "advance-payments"] });
      qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "statement"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

// ─── Customer Special Prices ──────────────────────────────────────────────────

export interface CustomerPrice {
  id: string;
  customerId: string;
  productId: string;
  pricingTier: number;
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
  };
}

export function useCustomerPrices(customerId: string | undefined) {
  return useQuery({
    queryKey: ['customer-prices', customerId],
    queryFn: () => apiClient.get(`/customers/${customerId}/prices`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useUpsertCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, ...data }: { customerId: string; productId: string; pricingTier: number; notes?: string }) =>
      apiClient.post(`/customers/${customerId}/prices`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['customer-prices', vars.customerId] });
    },
  });
}

export function useDeleteCustomerPrice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, priceId }: { customerId: string; priceId: string }) =>
      apiClient.delete(`/customers/${customerId}/prices/${priceId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ['customer-prices', vars.customerId] });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiClient.delete(`/customers/${id}`).then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); },
  });
}

export function useDeleteAllCustomers() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiClient.delete("/customers/all").then((r) => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["customers"] }); },
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
    mutationFn: (tagId: string) =>
      apiClient.delete(`/customers/tags/${tagId}`).then((r) => r.data),
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
    mutationFn: ({ customerId, ...data }: { customerId: string; firstName: string; lastName?: string; email?: string; phone?: string; mobile?: string; salutation?: string; isPrimary?: boolean }) =>
      apiClient.post(`/customers/${customerId}/contacts`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
  });
}

export function useUpdateContactPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, contactId, ...data }: { customerId: string; contactId: string; [k: string]: unknown }) =>
      apiClient.patch(`/customers/${customerId}/contacts/${contactId}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
  });
}

export function useDeleteContactPerson() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, contactId }: { customerId: string; contactId: string }) =>
      apiClient.delete(`/customers/${customerId}/contacts/${contactId}`).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "contacts"] }),
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
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "comments"] }),
  });
}

export function useDeleteCustomerComment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ customerId, commentId }: { customerId: string; commentId: string }) =>
      apiClient.delete(`/customers/${customerId}/comments/${commentId}`).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.customerId, "comments"] }),
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
    mutationFn: ({ id, method, overrideEmail }: { id: string; method: "EMAIL" | "SMS"; overrideEmail?: string }) =>
      apiClient.post(`/customers/${id}/portal-invite`, { method, overrideEmail }).then((r) => r.data),
    onSuccess: (_d, vars) => qc.invalidateQueries({ queryKey: ["customers", vars.id, "portal-status"] }),
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

export function useApprovePortalRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiClient.post(`/customers/${id}/portal-approve`).then((r) => r.data),
    onSuccess: (_d, id) => qc.invalidateQueries({ queryKey: ["customers", id, "portal-status"] }),
  });
}

export interface PendingPortalApproval {
  id: string;
  customerId: string;
  customer: { id: string; businessName: string; contactName: string; email: string | null };
  buyerAccount: { id: string; email: string; name: string } | null;
  createdAt: string;
}

export function usePendingPortalApprovals() {
  return useQuery<PendingPortalApproval[]>({
    queryKey: ["customers", "pending-portal-approvals"],
    queryFn: () => apiClient.get("/customers/pending-portal-approvals").then((r) => r.data),
    refetchInterval: 30_000, // auto-refresh every 30 s
  });
}

export function useApprovePortalFromList() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (customerId: string) =>
      apiClient.post(`/customers/${customerId}/portal-approve`).then((r) => r.data),
    onSuccess: (_d, customerId) => {
      qc.invalidateQueries({ queryKey: ["customers", "pending-portal-approvals"] });
      qc.invalidateQueries({ queryKey: ["customers", customerId, "portal-status"] });
    },
  });
}
