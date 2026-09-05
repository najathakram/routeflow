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
  lastRunStatus?: "SUCCESS" | "FAILED" | null;
  lastError?: string | null;
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

// ─── Create ─────────────────────────────────────────────────────────────────

/** A line on a NEW recurring template (no id; no boxes/pieces — the DTO rejects them). */
export interface CreateRecurringInvoiceItem {
  description: string;
  productId?: string;
  qty: number;
  unitPrice: number;
  discount?: number;
  taxRate?: number;
}

export interface CreateRecurringInvoiceDto {
  customerId: string;
  frequency: RecurringFrequency;
  /** 0–6, sent only for WEEKLY/BIWEEKLY. */
  dayOfWeek?: number;
  /** 1–28, sent only for MONTHLY. */
  dayOfMonth?: number;
  autoSend?: boolean;
  notes?: string;
  terms?: string;
  discount?: number;
  shippingFee?: number;
  /** Full ISO datetime for the first run (NOT bare YYYY-MM-DD). */
  nextRunAt: string;
  items: CreateRecurringInvoiceItem[];
}

/** Create a recurring-invoice template (`POST /recurring-invoices`). */
export function useCreateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, CreateRecurringInvoiceDto>({
    mutationFn: (dto) => apiClient.post("/recurring-invoices", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["recurring-invoices"] }),
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

/**
 * Generate an invoice from the template now. `POST /:id/run` returns the CREATED
 * Invoice keyed `id` (DRAFT, or SENT if the template auto-sends) — NOT a
 * RecurringInvoice — so type it `{ id }` and navigate to that invoice (same
 * class of fix as the estimates convert / credit-notes apply hooks).
 *
 * The server claims the cycle atomically before generating, so a losing racer
 * (a second tap, or the daily cron) gets NO invoice back — the response body is
 * empty. Typed nullable so callers must branch; axios yields `""` for that empty
 * body, so guard on `inv?.id`, not `inv != null`.
 */
export function useRunRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<{ id: string } | null, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/run`).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["recurring-invoices"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
    },
  });
}

function invalidateRecurring(qc: ReturnType<typeof useQueryClient>, id: string) {
  qc.invalidateQueries({ queryKey: ["recurring-invoices"] });
  qc.invalidateQueries({ queryKey: ["recurring-invoices", id] });
}

/** Pause a template — `DELETE /:id` soft-deactivates (sets isActive=false). */
export function useDeactivateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, string>({
    mutationFn: (id) => apiClient.delete(`/recurring-invoices/${id}`).then((r) => r.data),
    onSuccess: (_, id) => invalidateRecurring(qc, id),
  });
}

/** Resume a paused template — `POST /:id/activate` (the dedicated reactivate path). */
export function useActivateRecurringInvoice() {
  const qc = useQueryClient();
  return useMutation<RecurringInvoice, Error, string>({
    mutationFn: (id) => apiClient.post(`/recurring-invoices/${id}/activate`).then((r) => r.data),
    onSuccess: (_, id) => invalidateRecurring(qc, id),
  });
}
