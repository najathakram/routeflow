import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface CustomerSummary {
  id: string;
  businessName: string;
  contactName?: string;
  phone?: string;
  email?: string;
  status: string;
}

export function useCustomers(search?: string) {
  return useQuery<{ data: CustomerSummary[]; total: number }>({
    queryKey: ['customers', 'list', search ?? ''],
    queryFn: () =>
      apiClient
        .get('/customers', { params: { search: search || undefined, limit: 100 } })
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
  addresses: Array<{
    id: string;
    line1: string;
    line2?: string;
    city: string;
    state: string;
    zip: string;
    isDefault?: boolean;
  }>;
}

export function useCustomer(id: string) {
  return useQuery<CustomerDetail>({
    queryKey: ['customers', id],
    queryFn: () => apiClient.get(`/customers/${id}`).then((r) => r.data),
    enabled: !!id,
    staleTime: 2 * 60_000,
  });
}
