import { useQuery } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface CustomerAddress {
  id: string;
  label?: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
  isDefault: boolean;
}

export interface CustomerProfile {
  id: string;
  businessName: string;
  contactName: string;
  phone?: string;
  notes?: string;
  deliveryWindowStart?: string;
  deliveryWindowEnd?: string;
  addresses: CustomerAddress[];
  user?: {
    id: string;
    email: string;
    username: string;
  };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyCustomerProfile() {
  return useQuery<CustomerProfile>({
    queryKey: ['customers', 'me'],
    queryFn: () => apiClient.get('/customers/me').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}
