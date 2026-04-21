import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ReturnReason =
  | 'DAMAGED'
  | 'WRONG_ITEM'
  | 'CUSTOMER_REFUSED'
  | 'QUALITY_ISSUE'
  | 'EXCESS_ORDER';

export type ReturnStatus = 'PENDING' | 'PROCESSED' | 'CANCELLED';

export interface ReturnItem {
  id: string;
  productId: string;
  product?: { id: string; name: string; unit: string };
  qty: number;
  reason: ReturnReason;
  restock: boolean;
}

export interface Return {
  id: string;
  orderId: string;
  order?: { id: string; orderNumber: string };
  reason: ReturnReason;
  status: ReturnStatus;
  notes?: string;
  creditNoteId?: string;
  items: ReturnItem[];
  createdAt: string;
  updatedAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useMyReturns(params?: { status?: string }) {
  return useQuery<PaginatedResponse<Return>>({
    queryKey: ['returns', 'mine', params],
    queryFn: () =>
      apiClient.get('/returns', { params }).then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useMyReturn(id: string) {
  return useQuery<Return>({
    queryKey: ['returns', id],
    queryFn: () => apiClient.get(`/returns/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export interface CreateReturnItemDto {
  productId: string;
  qty: number;
  reason: ReturnReason;
  restock?: boolean;
}

export interface CreateReturnDto {
  orderId: string;
  reason: ReturnReason;
  notes?: string;
  items: CreateReturnItemDto[];
  photoUrls?: string[];
}

export function useCreateReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, CreateReturnDto>({
    mutationFn: (dto) => apiClient.post('/returns', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}

function returnTransition(action: 'approve' | 'reject' | 'in-transit' | 'receive' | 'refund' | 'cancel') {
  return (id: string) => apiClient.post(`/returns/${id}/${action}`).then((r) => r.data as Return);
}

export function useApproveReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition('approve'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}

export function useRejectReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition('reject'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}

export function useReceiveReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition('receive'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}

export function useRefundReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition('refund'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}

export function useCancelReturn() {
  const qc = useQueryClient();
  return useMutation<Return, Error, string>({
    mutationFn: returnTransition('cancel'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['returns'] }),
  });
}
