import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Sales agents & commissions (PR-D) ─────────────────────────────────────
//
// Client for the engine shipped dark in PR-C (`apps/api/src/sales-agents/*`),
// gated behind `flag.sales_agents` / the `sales_agents` addon
// (`useHasAddon(SALES_AGENTS_ADDON)`, lib/api/addons.ts). The server
// independently 403s every route via `PlanFlagGuard` — every query hook below
// takes an `opts?: { enabled?: boolean }` gate so an unflagged tenant never
// fires a request (a gated GET that 403s triggers the PLAN_GATE toast bridge,
// api-client.ts → PlanGateNotice.tsx, which would spam every page load).
//
// Money/rate discipline: every amount/rate field below is typed
// `number | string` because Prisma `Decimal` serializes as a JSON string —
// callers MUST wrap every read in `Number(...)` before display or math.
// NEVER recompute a commission client-side; render STORED amounts only.

// ─── Types ──────────────────────────────────────────────────────────────────

export type SalesAgentStatus = "ACTIVE" | "PAUSED" | "STOPPED_FOR_NEW";

export interface SalesAgent {
  id: string;
  name: string;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
  status: SalesAgentStatus;
  stopNewBusinessAt?: string | null;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
  /** List-view extras (findAll only). */
  openAssignmentCount?: number;
  currentRatePct?: number | string | null;
}

export interface SalesAgentRate {
  id: string;
  agentId: string;
  ratePct: number | string;
  effectiveFrom: string;
  createdAt: string;
}

export interface AgentAssignmentOpen {
  id: string;
  effectiveFrom: string;
  customer?: { id: string; businessName: string };
}

export interface SalesAgentDetail extends SalesAgent {
  rates: SalesAgentRate[];
  assignments: AgentAssignmentOpen[];
  accrualTotals: { accrued: number | string; payable: number | string; claimed: number | string };
}

export type CommissionRateSource = "ORDER_OVERRIDE" | "CUSTOMER_RATE" | "AGENT_DEFAULT" | "NONE";

export const RATE_SOURCE_LABELS: Record<CommissionRateSource, string> = {
  ORDER_OVERRIDE: "Order override",
  CUSTOMER_RATE: "Customer rate",
  AGENT_DEFAULT: "Agent default",
  NONE: "No rate",
};

export type CommissionAccrualStatus = "PENDING" | "PARTIAL" | "PAYABLE" | "SETTLED" | "VOID";

export interface CommissionAccrualRow {
  id: string;
  invoice: { id: string; invoiceNumber: string };
  customer: { id: string; businessName: string };
  basisDate: string;
  baseAmount: number | string;
  ratePct: number | string;
  rateSource: CommissionRateSource;
  accruedAmount: number | string;
  payableAmount: number | string;
  claimedAmount: number | string;
  /** API-computed remainder — render as returned, never subtract client-side. */
  adjustmentsTotal: number | string;
  drift: number | string;
  status: CommissionAccrualStatus;
}

export interface CurrentAssignment {
  assignment: {
    id: string;
    effectiveFrom: string;
    agent: { id: string; name: string; status: SalesAgentStatus; deletedAt: string | null };
  } | null;
  customerRatePct: number | null;
}

export type CommissionStatementStatus = "PENDING" | "APPROVED" | "PAID" | "VOID";

export interface CommissionStatement {
  id: string;
  statementNumber: string;
  agentId: string;
  agent: { id: string; name: string };
  status: CommissionStatementStatus;
  periodFrom?: string | null;
  periodTo?: string | null;
  totalAmount: number | string;
  paidAmount: number | string;
  approvedAt?: string | null;
  createdAt: string;
}

export type CommissionStatementLineKind = "CLAIM" | "ADJUSTMENT" | "CARRYFORWARD";

export interface CommissionStatementLine {
  id: string;
  kind: CommissionStatementLineKind;
  amount: number | string;
  description?: string | null;
  accrual?: { id: string; invoice: { id: string; invoiceNumber: string } } | null;
  adjustment?: { kind: string; reason?: string | null } | null;
  carriedFrom?: { id: string; statementNumber: string } | null;
}

export interface CommissionPayout {
  id: string;
  amount: number | string;
  method: string;
  reference?: string | null;
  notes?: string | null;
  paidAt: string;
  createdAt: string;
}

export interface CommissionStatementDetail extends CommissionStatement {
  lines: CommissionStatementLine[];
  payouts: CommissionPayout[];
}

/** Rate/assignment mutations may backdate and trigger an invoice resync — the
 *  response carries this so the page can toast the recomputed count. */
export interface RecomputeResult {
  recompute?: { invoicesSynced: number };
}

/** `pctLabel(12.5) === "12.5%"` — the ONLY client-side rate formatting; never
 *  divide by 100 or multiply against a base. */
export function pctLabel(v: number | string): string {
  return `${Number(v)}%`;
}

// ─── Queries — agents ───────────────────────────────────────────────────────

export function useSalesAgents(
  params?: { status?: string; search?: string; includeDeleted?: boolean },
  opts?: { enabled?: boolean },
) {
  return useQuery<SalesAgent[]>({
    queryKey: ["sales-agents", params],
    queryFn: () => apiClient.get("/sales-agents", { params }).then((r) => r.data),
    // NEVER fire while the tenant lacks the addon — a gated GET 403s and the
    // PLAN_GATE bridge (api-client.ts) would toast on every page load.
    enabled: opts?.enabled !== false,
  });
}

export function useSalesAgent(id: string, opts?: { enabled?: boolean }) {
  return useQuery<SalesAgentDetail>({
    queryKey: ["sales-agents", id],
    queryFn: () => apiClient.get(`/sales-agents/${id}`).then((r) => r.data),
    enabled: !!id && opts?.enabled !== false,
  });
}

export function useAgentAccruals(
  id: string,
  params?: { status?: string; from?: string; to?: string; page?: number; limit?: number },
  opts?: { enabled?: boolean },
) {
  return useQuery<{ items: CommissionAccrualRow[]; total: number; page: number; limit: number }>({
    queryKey: ["sales-agents", id, "accruals", params],
    queryFn: () => apiClient.get(`/sales-agents/${id}/accruals`, { params }).then((r) => r.data),
    enabled: !!id && opts?.enabled !== false,
  });
}

export function useCustomerCurrentAgent(customerId: string, opts?: { enabled?: boolean }) {
  return useQuery<CurrentAssignment>({
    queryKey: ["sales-agents", "current-assignment", customerId],
    queryFn: () =>
      apiClient
        .get("/sales-agents/assignments/current", { params: { customerId } })
        .then((r) => r.data),
    enabled: !!customerId && opts?.enabled !== false,
  });
}

// ─── Mutations — agents, rates, assignments ────────────────────────────────

export function useCreateSalesAgent() {
  const qc = useQueryClient();
  return useMutation<
    SalesAgentDetail,
    Error,
    {
      name: string;
      email?: string;
      phone?: string;
      notes?: string;
      defaultRatePct?: number;
      rateEffectiveFrom?: string;
    }
  >({
    mutationFn: (dto) => apiClient.post("/sales-agents", dto).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sales-agents"] }),
  });
}

export function useUpdateSalesAgent() {
  const qc = useQueryClient();
  return useMutation<
    SalesAgentDetail,
    Error,
    { id: string; name?: string; email?: string | null; phone?: string; notes?: string }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.patch(`/sales-agents/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useUpdateSalesAgentStatus() {
  const qc = useQueryClient();
  return useMutation<
    SalesAgentDetail,
    Error,
    { id: string; status: SalesAgentStatus; stopNewBusinessAt?: string }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.patch(`/sales-agents/${id}/status`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useDeleteSalesAgent() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, string>({
    mutationFn: (id) => apiClient.delete(`/sales-agents/${id}`).then((r) => r.data),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useAddAgentRate() {
  const qc = useQueryClient();
  return useMutation<
    SalesAgentRate & RecomputeResult,
    Error,
    { id: string; ratePct: number; effectiveFrom: string }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/sales-agents/${id}/rates`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useRemoveAgentRate() {
  const qc = useQueryClient();
  return useMutation<{ success: boolean }, Error, { id: string; rateId: string }>({
    mutationFn: ({ id, rateId }) =>
      apiClient.delete(`/sales-agents/${id}/rates/${rateId}`).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useAddCustomerRate() {
  const qc = useQueryClient();
  return useMutation<
    RecomputeResult,
    Error,
    { id: string; customerId: string; ratePct: number; effectiveFrom: string }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/sales-agents/${id}/customer-rates`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
      qc.invalidateQueries({
        queryKey: ["sales-agents", "current-assignment", vars.customerId],
      });
    },
  });
}

export function useAddAssignment(agentId: string) {
  const qc = useQueryClient();
  return useMutation<RecomputeResult, Error, { customerId: string; effectiveFrom?: string }>({
    mutationFn: (data) =>
      apiClient.post(`/sales-agents/${agentId}/assignments`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", agentId] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
      qc.invalidateQueries({
        queryKey: ["sales-agents", "current-assignment", vars.customerId],
      });
    },
  });
}

export function useBulkAssign(agentId: string) {
  const qc = useQueryClient();
  return useMutation<RecomputeResult, Error, { customerIds: string[]; effectiveFrom?: string }>({
    mutationFn: (data) =>
      apiClient.post(`/sales-agents/${agentId}/assignments/bulk`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", agentId] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
      for (const customerId of vars.customerIds) {
        qc.invalidateQueries({ queryKey: ["sales-agents", "current-assignment", customerId] });
      }
    },
  });
}

export function useCloseAssignment() {
  const qc = useQueryClient();
  return useMutation<RecomputeResult, Error, { customerId: string; effectiveTo?: string }>({
    mutationFn: (data) =>
      apiClient.post("/sales-agents/assignments/close", data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
      qc.invalidateQueries({
        queryKey: ["sales-agents", "current-assignment", vars.customerId],
      });
    },
  });
}

export function useRecomputeAgent() {
  const qc = useQueryClient();
  return useMutation<{ invoicesSynced: number }, Error, { id: string; fromDate: string }>({
    mutationFn: ({ id, fromDate }) =>
      apiClient.post(`/sales-agents/${id}/recompute`, { fromDate }).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["sales-agents", vars.id] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

// ─── Queries + mutations — commission statements ───────────────────────────

export function useCommissionStatements(
  params?: { agentId?: string; status?: string },
  opts?: { enabled?: boolean },
) {
  return useQuery<CommissionStatement[]>({
    queryKey: ["commission-statements", params],
    queryFn: () => apiClient.get("/commission-statements", { params }).then((r) => r.data),
    enabled: opts?.enabled !== false,
  });
}

export function useCommissionStatement(id: string, opts?: { enabled?: boolean }) {
  return useQuery<CommissionStatementDetail>({
    queryKey: ["commission-statements", id],
    queryFn: () => apiClient.get(`/commission-statements/${id}`).then((r) => r.data),
    enabled: !!id && opts?.enabled !== false,
  });
}

export function useGenerateStatement() {
  const qc = useQueryClient();
  return useMutation<
    CommissionStatement,
    Error,
    { agentId: string; periodFrom?: string; periodTo?: string }
  >({
    mutationFn: (dto) => apiClient.post("/commission-statements/generate", dto).then((r) => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["commission-statements"] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useApproveStatement() {
  const qc = useQueryClient();
  return useMutation<CommissionStatementDetail, Error, string>({
    mutationFn: (id) => apiClient.post(`/commission-statements/${id}/approve`).then((r) => r.data),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["commission-statements", id] });
      qc.invalidateQueries({ queryKey: ["commission-statements"] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useVoidStatement() {
  const qc = useQueryClient();
  return useMutation<CommissionStatementDetail, Error, string>({
    mutationFn: (id) => apiClient.post(`/commission-statements/${id}/void`).then((r) => r.data),
    onSuccess: (_d, id) => {
      qc.invalidateQueries({ queryKey: ["commission-statements", id] });
      qc.invalidateQueries({ queryKey: ["commission-statements"] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}

export function useRecordCommissionPayout() {
  const qc = useQueryClient();
  return useMutation<
    CommissionPayout,
    Error,
    {
      id: string;
      amount: number;
      method: string;
      reference?: string;
      notes?: string;
      paidAt?: string;
    }
  >({
    mutationFn: ({ id, ...data }) =>
      apiClient.post(`/commission-statements/${id}/payouts`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["commission-statements", vars.id] });
      qc.invalidateQueries({ queryKey: ["commission-statements"] });
      qc.invalidateQueries({ queryKey: ["sales-agents"] });
    },
  });
}
