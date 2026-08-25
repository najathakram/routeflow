import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";
import type { SelectablePaymentMethod } from "../payment-methods";

export interface CustomerSummary {
  id: string;
  businessName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status: string;
}

export function useCustomers(search?: string) {
  return useQuery<{
    data: CustomerSummary[];
    meta: { total: number; page: number; limit: number; totalPages: number };
  }>({
    queryKey: ["customers", "list", search ?? ""],
    queryFn: () =>
      apiClient
        .get("/customers", { params: { search: search || undefined, limit: 100 } })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export interface CustomerDetail {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  email?: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  creditLimit?: number | string | null;
  pricingTier?: number;
  currency?: string;
  notes?: string;
  /**
   * The customer's DEFAULT fulfillment mode — new orders seed their own
   * `fulfillPath` from it (`NewOrderScreen`, web `CreateOrderModal`); it never
   * constrains an existing order. Optional because the API has returned it
   * since launch (`Customer.fulfillPath @default(ROUTE)`) but older cached
   * payloads may predate this client reading it.
   */
  fulfillPath?: "ROUTE" | "SHIP";
  addresses: Array<{
    id: string;
    label?: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    isDefault?: boolean;
    /** Free string server-side, but the update route only accepts these three. */
    addressType?: string;
    lat?: number | null;
    lng?: number | null;
    notes?: string;
  }>;
  tagAssignments?: Array<{ tag: { id: string; name: string; color?: string } }>;
  user?: { id: string; email?: string; username?: string; status?: string };
}

export interface CustomerStatement {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  advanceBalance: number;
  pendingOrdersAmount: number;
  transactions: Array<{
    id: string;
    type: string;
    description: string;
    date: string;
    amount: number;
    runningBalance: number;
    status?: string;
  }>;
}

export function useCustomerStatement(id: string) {
  return useQuery<CustomerStatement>({
    queryKey: ["customers", id, "statement"],
    queryFn: () => apiClient.get(`/customers/${id}/statement`).then((r) => r.data),
    enabled: !!id,
    staleTime: 60_000,
  });
}

/** Month buckets with a downloadable statement PDF — operator twin of the
 *  buyer portal's `GET /buyer/statements` (newest first, ≤12). */
export function useCustomerStatementMonths(id: string) {
  return useQuery<{ months: string[] }>({
    queryKey: ["customers", id, "statement-months"],
    queryFn: () => apiClient.get(`/customers/${id}/statements`).then((r) => r.data),
    enabled: !!id,
    staleTime: 5 * 60_000,
  });
}

/** Imperative (not a query): render + upload the month's statement PDF and
 *  return its presigned URL — mirrors the buyer `fetchStatementPdfUrl`. */
export async function fetchCustomerStatementPdfUrl(id: string, month: string): Promise<string> {
  const r = await apiClient.get<{ url: string }>(`/customers/${id}/statements/${month}`);
  return r.data.url;
}

// ─── Advance payments (Wave 3 — mobile is the FIRST client for apply) ────────

export interface AdvancePayment {
  id: string;
  customerId: string;
  /** Original deposit — immutable. Used = amount − balance. */
  amount: number | string;
  /** Remaining wallet balance; decremented on apply, restored on void/delete. */
  balance: number | string;
  method: string;
  reference?: string | null;
  notes?: string | null;
  receivedAt?: string;
  createdAt: string;
}

/** GET /customers/:id/advance-payments — raw array, newest received first. */
export function useCustomerAdvancePayments(customerId: string) {
  return useQuery<AdvancePayment[]>({
    queryKey: ["customers", customerId, "advance-payments"],
    queryFn: () => apiClient.get(`/customers/${customerId}/advance-payments`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export interface CreateAdvancePaymentDto {
  customerId: string;
  /** Cents-rounded CLIENT-side — the server stores it verbatim (no roundMoney,
   *  and no class-validator on these routes at all — validate before sending). */
  amount: number;
  /** Hand-enterable methods only — see lib/payment-methods.ts (web offers the same list). */
  method: SelectablePaymentMethod;
  reference?: string;
  notes?: string;
}

/** POST /customers/:id/advance-payments — take a deposit into the wallet. */
export function useCreateAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<AdvancePayment, Error, CreateAdvancePaymentDto>({
    mutationFn: ({ customerId, ...body }) =>
      apiClient.post(`/customers/${customerId}/advance-payments`, body).then((r) => r.data),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

/**
 * POST /customers/:id/advance-payments/:apId/apply — draw the wallet down onto
 * an invoice (payment row method ADVANCE, reference AP-<id-8>). Omitting
 * `amount` applies min(wallet balance, invoice balance). Server guards
 * (verbatim): "Advance payment has no remaining balance", "Cannot apply
 * advance payment to invoice with status <S>", "Invoice has no outstanding
 * balance". ⚠️ Its status recompute is inline and does NOT preserve DRAFT —
 * gate the UI to SENT/VIEWED/PARTIAL/OVERDUE so a draft is never silently
 * flipped. Returns the UPDATED INVOICE.
 */
export function useApplyAdvancePayment() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { customerId: string; advanceId: string; invoiceId: string; amount?: number }
  >({
    mutationFn: ({ customerId, advanceId, invoiceId, amount }) =>
      apiClient
        .post(`/customers/${customerId}/advance-payments/${advanceId}/apply`, {
          invoiceId,
          ...(amount != null ? { amount } : {}),
        })
        .then((r) => r.data),
    onSuccess: (_, { customerId, invoiceId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices"] });
      qc.invalidateQueries({ queryKey: ["admin", "invoices", invoiceId] });
      qc.invalidateQueries({ queryKey: ["invoices", "payments"] });
    },
  });
}

export interface CustomerPrice {
  id: string;
  customerId: string;
  productId: string;
  /** Null = msrp-only override row; price at the customer's default tier. */
  pricingTier: number | null;
  /** Per-customer MSRP override (display-only, per PIECE). Mobile never edits it. */
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
  };
}

export function useCustomerPrices(id: string) {
  return useQuery<CustomerPrice[]>({
    queryKey: ["customers", id, "prices"],
    queryFn: () => apiClient.get(`/customers/${id}/prices`).then((r) => r.data),
    enabled: !!id,
    staleTime: 2 * 60_000,
  });
}

export function useUpsertCustomerPrice() {
  const qc = useQueryClient();
  return useMutation<
    CustomerPrice,
    Error,
    // pricingTier null = "no tier override" — only valid on a row that keeps its
    // MSRP override (the server deletes a row cleared of both fields, and holds
    // that delete to OPERATOR level).
    { customerId: string; productId: string; pricingTier: number | null; notes?: string }
  >({
    mutationFn: ({ customerId, ...body }) =>
      apiClient.post(`/customers/${customerId}/prices`, body).then((r) => r.data),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId, "prices"] });
    },
  });
}

export function useDeleteCustomerPrice() {
  const qc = useQueryClient();
  return useMutation<void, Error, { customerId: string; priceId: string }>({
    mutationFn: ({ customerId, priceId }) =>
      apiClient.delete(`/customers/${customerId}/prices/${priceId}`).then(() => undefined),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId, "prices"] });
    },
  });
}

export function useCustomer(id: string) {
  return useQuery<CustomerDetail>({
    queryKey: ["customers", id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 2 * 60_000,
  });
}

export interface CustomerCurrentAgent {
  assignment: {
    id: string;
    effectiveFrom: string;
    agent: { id: string; name: string; status: string; deletedAt: string | null };
  } | null;
  customerRatePct: number | null;
}

/** Read-only mirror of web's agent box. MUST stay `enabled`-gated: the route is
 *  plan-flag gated and 403s for tenants without the sales_agents addon. */
export function useCustomerCurrentAgent(customerId: string, enabled: boolean) {
  return useQuery<CustomerCurrentAgent>({
    queryKey: ["sales-agents", "current-assignment", customerId],
    queryFn: () =>
      apiClient
        .get("/sales-agents/assignments/current", { params: { customerId } })
        .then((r) => r.data),
    enabled: !!customerId && enabled,
    staleTime: 2 * 60_000,
  });
}

// ─── My profile (CUSTOMER role) ───────────────────────────────────────────────

export interface MyCustomerProfile extends Omit<CustomerDetail, "user"> {
  user?: { id?: string; email?: string };
}

export function useMyCustomerProfile() {
  return useQuery<MyCustomerProfile>({
    queryKey: ["customers", "me"],
    queryFn: () => apiClient.get("/customers/me").then((r) => r.data),
    staleTime: 2 * 60_000,
  });
}

// ─── Account statement (CUSTOMER role) ───────────────────────────────────────

export type TransactionType = "INVOICE" | "PAYMENT" | "CREDIT_NOTE" | "ADJUSTMENT";

export interface AccountTransaction {
  id: string;
  type: TransactionType;
  description: string;
  date: string;
  amount: number;
  runningBalance: number;
  status?: string;
}

export interface AccountSummary {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  transactions: AccountTransaction[];
}

export function useMyAccountSummary() {
  return useQuery<AccountSummary>({
    queryKey: ["customers", "me", "statement"],
    queryFn: () => apiClient.get("/customers/me/statement").then((r) => r.data),
    staleTime: 60_000,
  });
}

// ─── Mutations (operator) ────────────────────────────────────────────────────

export interface CreateCustomerDto {
  businessName: string;
  /** Create-only, and REQUIRED there — the API mints the linked User from it. */
  username?: string;
  contactName?: string;
  email?: string;
  phone?: string;
  status?: string;
  creditLimit?: number;
  pricingTier?: number;
  currency?: string;
  notes?: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  isTaxExempt?: boolean;
  taxId?: string;
  /** Default fulfillment mode for this customer's new orders (server default ROUTE). */
  fulfillPath?: "ROUTE" | "SHIP";
  /** Create-only: the customer's first address, bundled with the create. */
  addresses?: Array<{
    label: string;
    line1: string;
    city: string;
    state: string;
    zip: string;
    isDefault?: boolean;
  }>;
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  // POST /customers returns { customer, user, tempPassword } — not a bare customer.
  return useMutation<{ customer: { id: string } }, Error, CreateCustomerDto>({
    mutationFn: (dto) => apiClient.post("/customers", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
  });
}

export function useUpdateCustomer() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, { id: string } & Partial<CreateCustomerDto>>({
    mutationFn: ({ id, ...dto }) => apiClient.patch(`/customers/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customers", id] });
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
  });
}

export function useDeleteCustomer() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => apiClient.delete(`/customers/${id}`).then(() => undefined),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["admin", "customers"] });
    },
  });
}

/** Mirrors Create/UpdateAddressDto EXACTLY. The API's global ValidationPipe runs
 *  `forbidNonWhitelisted`, so any extra key (country, notes, lat, lng…) is a 400,
 *  not a silent strip — coordinates in particular are server-owned (it geocodes on
 *  add and clears + re-geocodes on update). Do not widen without the DTO. */
export interface CustomerAddressDto {
  /** Required by CreateAddressDto server-side (empty string is a valid value). */
  label: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  isDefault?: boolean;
  /** Update route validates against ["BILLING","SHIPPING","DELIVERY"]. */
  addressType?: string;
}

export function useAddCustomerAddress() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, { customerId: string } & CustomerAddressDto>({
    mutationFn: ({ customerId, ...body }) =>
      apiClient.post(`/customers/${customerId}/addresses`, body).then((r) => r.data),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
    },
  });
}

export function useUpdateCustomerAddress() {
  const qc = useQueryClient();
  return useMutation<
    { id: string },
    Error,
    { customerId: string; addressId: string } & Partial<CustomerAddressDto>
  >({
    mutationFn: ({ customerId, addressId, ...body }) =>
      apiClient.patch(`/customers/${customerId}/addresses/${addressId}`, body).then((r) => r.data),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
    },
  });
}

/** DELETE :id/addresses/:addrId — 409 (ConflictException) when a RouteStop or
 *  RouteRunStop still references the address; server promotes the oldest
 *  remaining address to default when the deleted row was the default. */
export function useDeleteCustomerAddress() {
  const qc = useQueryClient();
  return useMutation<void, Error, { customerId: string; addressId: string }>({
    mutationFn: ({ customerId, addressId }) =>
      apiClient.delete(`/customers/${customerId}/addresses/${addressId}`).then(() => undefined),
    onSuccess: (_, { customerId }) => {
      qc.invalidateQueries({ queryKey: ["customers", customerId] });
    },
  });
}

// ─── Documents ────────────────────────────────────────────────────────────────

export interface CustomerDocument {
  id: string;
  docType: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
  createdAt: string;
  /** Freshly presigned on every list call — safe to open directly, no auth header needed. */
  url: string;
}

/** Same vocabulary as web's Documents tab. `docType` is a free string server-side. */
export const CUSTOMER_DOC_TYPES = [
  "Tax Exempt Certificate",
  "Resale Certificate",
  "W-9",
  "Signed Agreement",
  "Other",
] as const;

export function useCustomerDocuments(customerId: string) {
  return useQuery<CustomerDocument[]>({
    queryKey: ["customers", customerId, "documents"],
    queryFn: () => apiClient.get(`/customers/${customerId}/documents`).then((r) => r.data),
    enabled: !!customerId,
  });
}

/**
 * Upload photographed documents — multipart field name `files` (exactly; the
 * server's FilesInterceptor matches it) plus the text field `docType`. Each RN
 * FormData part MUST declare an allow-listed `type` (JPEG/PNG/WEBP/PDF) or the
 * server's fileFilter 400s; the server re-compresses images anyway
 * (`compressDocument` → JPEG ≤1600px). 60s timeout for that compression.
 * NOT offline-queued (the api-client skips FormData mutations) — best-effort.
 */
export function useUploadCustomerDocuments(customerId: string) {
  const qc = useQueryClient();
  return useMutation<
    { uploaded: CustomerDocument[] },
    Error,
    { docType: string; files: { uri: string; name: string; type: string }[] }
  >({
    mutationFn: ({ docType, files }) => {
      const form = new FormData();
      form.append("docType", docType);
      for (const f of files) form.append("files", f as unknown as Blob);
      return apiClient
        .post(`/customers/${customerId}/documents`, form, {
          headers: { "Content-Type": "multipart/form-data" },
          timeout: 60_000,
        })
        .then((r) => r.data);
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

// ─── Contact persons ─────────────────────────────────────────────────────────

export interface ContactPerson {
  id: string;
  salutation?: string | null;
  firstName: string;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  mobile?: string | null;
  isPrimary: boolean;
  createdAt: string;
}

export interface ContactPersonInput {
  salutation?: string;
  firstName: string;
  lastName?: string;
  email?: string;
  phone?: string;
  mobile?: string;
  /** Server enforces the single-primary invariant in a transaction. */
  isPrimary?: boolean;
}

const contactsKey = (customerId: string) => ["customers", customerId, "contacts"] as const;

/** Primary first, then oldest-first (server ordering). */
export function useContactPersons(customerId: string) {
  return useQuery<ContactPerson[]>({
    queryKey: contactsKey(customerId),
    queryFn: () => apiClient.get(`/customers/${customerId}/contacts`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useAddContactPerson(customerId: string) {
  const qc = useQueryClient();
  return useMutation<ContactPerson, Error, ContactPersonInput>({
    mutationFn: (dto) =>
      apiClient.post(`/customers/${customerId}/contacts`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey(customerId) }),
  });
}

export function useUpdateContactPerson(customerId: string) {
  const qc = useQueryClient();
  return useMutation<ContactPerson, Error, { contactId: string } & Partial<ContactPersonInput>>({
    mutationFn: ({ contactId, ...dto }) =>
      apiClient.patch(`/customers/${customerId}/contacts/${contactId}`, dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey(customerId) }),
  });
}

export function useDeleteContactPerson(customerId: string) {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (contactId) =>
      apiClient.delete(`/customers/${customerId}/contacts/${contactId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: contactsKey(customerId) }),
  });
}

// ─── Comments ────────────────────────────────────────────────────────────────

/** NOTE: the server does NOT include the author relation — there is no name to
 *  render (web falls back to "User" too). Distinct from `Customer.notes`. */
export interface CustomerComment {
  id: string;
  content: string;
  createdAt: string;
}

const commentsKey = (customerId: string) => ["customers", customerId, "comments"] as const;

export function useCustomerComments(customerId: string) {
  return useQuery<CustomerComment[]>({
    queryKey: commentsKey(customerId),
    queryFn: () => apiClient.get(`/customers/${customerId}/comments`).then((r) => r.data),
    enabled: !!customerId,
  });
}

export function useAddCustomerComment(customerId: string) {
  const qc = useQueryClient();
  return useMutation<CustomerComment, Error, string>({
    mutationFn: (content) =>
      apiClient.post(`/customers/${customerId}/comments`, { content }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsKey(customerId) }),
  });
}

export function useDeleteCustomerComment(customerId: string) {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (commentId) =>
      apiClient.delete(`/customers/${customerId}/comments/${commentId}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: commentsKey(customerId) }),
  });
}
