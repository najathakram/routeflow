import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { apiClient } from '../api-client';

export interface AppUser {
  id: string;
  username: string;
  email: string;
  role: 'OPERATOR' | 'DRIVER' | 'CUSTOMER';
  status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED';
  forcePasswordChange: boolean;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useUsers(params?: { search?: string; status?: string }) {
  return useQuery<PaginatedResponse<AppUser>>({
    queryKey: ['users', params],
    queryFn: () => apiClient.get('/users', { params }).then((r) => r.data),
  });
}

export function useCreateOperator() {
  const qc = useQueryClient();
  return useMutation<{ user: AppUser; tempPassword: string }, Error, { name: string; email: string; username: string }>({
    mutationFn: (dto) => apiClient.post('/users/operator', dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}

export function useChangeUserStatus() {
  const qc = useQueryClient();
  return useMutation<AppUser, Error, { id: string; status: 'ACTIVE' | 'INACTIVE' | 'SUSPENDED' }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/users/${id}/status`, { status }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  });
}
