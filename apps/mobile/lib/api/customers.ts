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

// ─── Account Summary ──────────────────────────────────────────────────────────

export type TransactionType = 'INVOICE' | 'PAYMENT' | 'CREDIT_NOTE' | 'ADJUSTMENT';

export interface AccountTransaction {
  id: string;
  type: TransactionType;
  date: string;
  description: string;
  amount: number;
  /** Positive = charge, negative = credit */
  runningBalance: number;
}

export interface AccountSummary {
  outstandingAmount: number;
  overdueAmount: number;
  availableCredit: number;
  transactions: AccountTransaction[];
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyCustomerProfile() {
  return useQuery<CustomerProfile>({
    queryKey: ['customers', 'me'],
    queryFn: () => apiClient.get('/customers/me').then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

export function useMyAccountSummary() {
  return useQuery<AccountSummary>({
    queryKey: ['customers', 'me', 'statement'],
    queryFn: () => apiClient.get('/customers/me/statement').then((r) => r.data),
    staleTime: 60_000,
  });
}
