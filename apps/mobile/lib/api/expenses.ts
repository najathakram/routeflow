import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type ExpenseStatus = "PENDING" | "RECEIVED" | "PAID" | "VOID";

export interface ExpenseCategory {
  id: string;
  name: string;
}

export interface Expense {
  id: string;
  date: string;
  amount: number;
  description?: string;
  status: ExpenseStatus;
  paymentMethod?: string;
  notes?: string;
  referenceNumber?: string;
  category?: { id: string; name: string };
  supplier?: { id: string; name: string };
  createdAt: string;
}

export interface CreateExpenseDto {
  date: string;
  amount: number;
  description?: string;
  categoryId?: string;
  supplierId?: string;
  paymentMethod?: string;
  notes?: string;
  referenceNumber?: string;
}

// ─── Queries ──────────────────────────────────────────────────────────────────

export function useExpenses(params?: {
  status?: ExpenseStatus;
  supplierId?: string;
  categoryId?: string;
  page?: number;
  limit?: number;
}) {
  return useQuery<{ data: Expense[]; meta: any }>({
    queryKey: ["expenses", params],
    queryFn: () =>
      apiClient
        .get("/bookkeeping/expenses", { params: { limit: 30, ...params } })
        .then((r) => r.data),
    staleTime: 30_000,
  });
}

export function useExpense(id: string) {
  return useQuery<Expense>({
    queryKey: ["expenses", id],
    queryFn: () => apiClient.get(`/bookkeeping/expenses/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

export function useExpenseCategories() {
  return useQuery<ExpenseCategory[]>({
    queryKey: ["expense-categories"],
    queryFn: () =>
      apiClient.get("/bookkeeping/expense-categories").then((r) => r.data),
    staleTime: 5 * 60_000,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

export function useCreateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, CreateExpenseDto>({
    mutationFn: (dto) =>
      apiClient.post("/bookkeeping/expenses", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses"] }),
  });
}

export function useUpdateExpense() {
  const qc = useQueryClient();
  return useMutation<Expense, Error, { id: string } & Partial<CreateExpenseDto>>({
    mutationFn: ({ id, ...dto }) =>
      apiClient.patch(`/bookkeeping/expenses/${id}`, dto).then((r) => r.data),
    onSuccess: (_, { id }) => {
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["expenses", id] });
    },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) =>
      apiClient.post(`/bookkeeping/expenses/${id}/delete`).then(() => undefined),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["expenses"] }),
  });
}
