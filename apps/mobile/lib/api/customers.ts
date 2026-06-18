import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

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
  addresses: Array<{
    id: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    country?: string;
    isDefault?: boolean;
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
    { customerId: string; productId: string; pricingTier: number; notes?: string }
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
}

export function useCreateCustomer() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, CreateCustomerDto>({
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

export interface CustomerAddressDto {
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  country?: string;
  lat?: number;
  lng?: number;
  isDefault?: boolean;
  notes?: string;
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
