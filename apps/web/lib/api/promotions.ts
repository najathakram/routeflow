import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiClient } from "../api-client";

// ─── Types (mirror apps/api/src/promotions DTOs + Prisma enums) ─────────────────

export type PromotionType = "PERCENT" | "FIXED" | "QTY_BREAK" | "BUY_N_GET_M";
export type PromotionScope = "ALL" | "CATEGORY" | "PRODUCTS";

export interface Promotion {
  id: string;
  name: string;
  bannerText?: string | null;
  type: PromotionType;
  /**
   * PERCENT: 0–100. FIXED: $ off per unit. QTY_BREAK: percent off at/over minQty.
   * BUY_N_GET_M reuses the same two columns — `minQty` = N (buy quantity),
   * `value` = M (free quantity); both integers ≥ 1. No dedicated N/M columns.
   */
  value: string | number;
  minQty?: number | null;
  scope: PromotionScope;
  category?: string | null;
  startsAt: string;
  endsAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  /** Join rows — present when scope = PRODUCTS. */
  products?: Array<{ productId: string }>;
}

export interface PromotionInput {
  name: string;
  bannerText?: string;
  type: PromotionType;
  value: number;
  minQty?: number;
  scope: PromotionScope;
  category?: string;
  productIds?: string[];
  startsAt: string;
  endsAt: string;
  isActive?: boolean;
  /**
   * Confirmation flag (never persisted): the operator has seen how many in-scope
   * products this rule would sell for $0.00 and means it. Without it the API
   * refuses such a rule with a 400 (`code: "PROMOTION_ZERO_PRICE"`).
   */
  allowZeroPrice?: boolean;
}

// ─── Reads ──────────────────────────────────────────────────────────────────────

export function usePromotions() {
  return useQuery<Promotion[]>({
    queryKey: ["promotions"],
    queryFn: () => apiClient.get("/promotions").then((r) => r.data),
  });
}

export function usePromotion(id: string | null) {
  return useQuery<Promotion>({
    queryKey: ["promotions", id],
    queryFn: () => apiClient.get(`/promotions/${id}`).then((r) => r.data),
    enabled: !!id,
  });
}

// ─── Mutations ────────────────────────────────────────────────────────────────

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["promotions"] });
}

export function useCreatePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: PromotionInput): Promise<Promotion> =>
      apiClient.post("/promotions", data).then((r) => r.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useUpdatePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: string } & Partial<PromotionInput>): Promise<Promotion> =>
      apiClient.patch(`/promotions/${id}`, data).then((r) => r.data),
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["promotions", vars.id] });
      invalidate(qc);
    },
  });
}

export function useSetPromotionActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, isActive }: { id: string; isActive: boolean }): Promise<Promotion> =>
      apiClient.patch(`/promotions/${id}/active`, { isActive }).then((r) => r.data),
    onSuccess: () => invalidate(qc),
  });
}

export function useDeletePromotion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string): Promise<{ deleted: boolean }> =>
      apiClient.delete(`/promotions/${id}`).then((r) => r.data),
    onSuccess: () => invalidate(qc),
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

export type PromotionStatus = "SCHEDULED" | "ACTIVE" | "EXPIRED" | "PAUSED";

/** Derive the display status of a promotion from its window + active flag. */
export function promotionStatus(p: Promotion, now: Date = new Date()): PromotionStatus {
  if (!p.isActive) return "PAUSED";
  const start = new Date(p.startsAt);
  const end = new Date(p.endsAt);
  if (now < start) return "SCHEDULED";
  if (now > end) return "EXPIRED";
  return "ACTIVE";
}

/** Human-readable summary of a promotion's rule, e.g. "15% off" or "$2.00 off / unit ≥ 10". */
export function promotionRuleLabel(p: Pick<Promotion, "type" | "value" | "minQty">): string {
  const value = Number(p.value);
  switch (p.type) {
    case "PERCENT":
      return `${value}% off`;
    case "FIXED":
      return `$${value.toFixed(2)} off / unit`;
    case "QTY_BREAK":
      return `${value}% off at ${p.minQty ?? 1}+ units`;
    case "BUY_N_GET_M":
      // Field reuse: minQty = N (buy), value = M (free). Never a percent — this
      // type gives whole free units and never changes the unit price.
      return `Buy ${p.minQty ?? 0}, get ${value} free`;
    default:
      return `${value}`;
  }
}
