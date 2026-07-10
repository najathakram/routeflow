import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/web/lib/api/invoices.ts recurring hooks) ────────────────

export type RecurringFrequency = "WEEKLY" | "BIWEEKLY" | "MONTHLY";

export interface RecurringInvoiceItem {
  id: string;
  productId?: string;
  description: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export interface RecurringInvoice {
  id: string;
  customerId: string;
  customer?: { id: string; businessName: string };
  frequency: RecurringFrequency;
  dayOfWeek?: number;
  dayOfMonth?: number;
  isActive: boolean; // state is a boolean, not a status enum
  autoSend: boolean;
  notes?: string;
  terms?: string;
  nextRunAt: string;
  lastRunAt?: string;
  items: RecurringInvoiceItem[];
  createdAt: string;
}

// ─── Queries (list endpoint returns a BARE array, not paginated) ────────────────

export function useRecurringInvoices(customerId?: string) {
  return useQuery<RecurringInvoice[]>({
    queryKey: ["recurring-invoices", customerId],
    queryFn: () =>
      apiClient
        .get("/recurring-invoices", { params: customerId ? { customerId } : undefined })
        .then((r) => r.data),
    staleTime: 60_000,
  });
}

export function useRecurringInvoice(id: string) {
  return useQuery<RecurringInvoice>({
    queryKey: ["recurring-invoices", id],
    queryFn: () => apiClient.get(`/recurring-invoices/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Generate an invoice from the template now. `POST /:id/run` returns the CREATED
 * Invoice keyed `id` (DRAFT, or SENT if the template auto-sends) — NOT a
 * RecurringInvoice — so type it `{ id }` and navigate to that invoice (same
 * class of fix as the estimates convert / credit-notes apply hooks).
 *
 * NOTE: pause (DELETE) / resume (PATCH isActive) are intentionally NOT exposed —
 * resume is a broken server path (the update() service drops isActive and the
 * global ValidationPipe rejects the partial body), so shipping Pause without a
 * working Resume would trap the template. Tracked as a separate backend fix.
 */
export function useRunRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<{ id: string }, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/run`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring-invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}
