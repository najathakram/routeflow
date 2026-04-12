import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export interface AppUser {
  id: string;
  username: string;
  email: string;
  role: "OPERATOR" | "DRIVER" | "CUSTOMER" | "TENANT_ADMIN";
  status: "ACTIVE" | "INACTIVE" | "SUSPENDED";
  forcePasswordChange: boolean;
  isAdmin?: boolean;
  canActAsDriver?: boolean;
  createdAt: string;
}

interface PaginatedResponse<T> {
  data: T[];
  meta: { total: number; page: number; limit: number; totalPages: number };
}

export function useUsers(params?: { search?: string; status?: string }) {
  return useQuery<PaginatedResponse<AppUser>>({
    queryKey: ["users", params],
    queryFn: () => apiClient.get("/users", { params }).then((r) => r.data),
  });
}

export function useCreateOperator() {
  const qc = useQueryClient();
  return useMutation<
    { user: AppUser; tempPassword: string },
    Error,
    { name: string; email: string; username: string }
  >({
    mutationFn: ({ name: _name, ...dto }) =>
      apiClient.post("/users/operator", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation<
    AppUser,
    Error,
    { id: string; email?: string; username?: string; role?: string }
  >({
    mutationFn: ({ id, ...data }) => apiClient.patch(`/users/${id}`, data).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useResetUserPassword() {
  return useMutation<{ tempPassword: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/users/${id}/reset-password`).then((r) => r.data),
  });
}

export function useChangeUserStatus() {
  const qc = useQueryClient();
  return useMutation<AppUser, Error, { id: string; status: "ACTIVE" | "INACTIVE" | "SUSPENDED" }>({
    mutationFn: ({ id, status }) =>
      apiClient.patch(`/users/${id}/status`, { status }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

// ─── User Preferences (smart defaults / ML adaptive UX) ──────────────────────

export function usePreferences() {
  return useQuery<Record<string, string>>({
    queryKey: ["user-preferences"],
    queryFn: () => apiClient.get("/users/me/preferences").then((r) => r.data),
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

export function useSavePreferences() {
  const qc = useQueryClient();
  return useMutation<Record<string, string>, Error, Record<string, string>>({
    mutationFn: (prefs) => apiClient.patch("/users/me/preferences", prefs).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["user-preferences"] }),
  });
}
