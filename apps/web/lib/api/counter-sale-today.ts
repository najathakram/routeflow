// Replace with the @routeflow/types import when POS-7b-1 lands; do not keep both.
// Mirrors packages/types/api/counter-sale.ts (TodaysSalesResponse / TodaysSaleRow / TodaysSalesSummary).
// `GET /orders/counter-sale/today?page=N`: today's counter sales, newest first.
// ASSUMPTION: `summary` is an optional top-level field (page 1 carries it); later pages may omit it.
import { useInfiniteQuery } from "@tanstack/react-query";
import { apiClient } from "../api-client";

export type TodaysTenderMethod = "CASH" | "CARD" | "CHECK" | "OTHER" | "STORE_CREDIT";

export interface TodaysSaleRow {
  orderId: string;
  invoiceId: string;
  orderNumber: string;
  invoiceNumber: string;
  /** ISO time of the sale: format it in `meta.timezone` */
  createdAt: string;
  total: number;
  customerId: string;
  customerName: string | null;
  isWalkIn: boolean;
  status: string;
  paymentState: "PAID" | "PARTLY_PAID" | "ON_ACCOUNT" | "UNPAID";
  /** STORE_CREDIT is a payment against the sale but is never money in */
  methods: { method: TodaysTenderMethod; amount: number }[];
  returned: {
    amount: number;
    state: "NONE" | "PARTLY" | "FULL" | "PENDING";
    returns: unknown[];
  };
  /** a cancelled sale: shown struck through, no Return action */
  voided: boolean;
}

export interface TodaysSalesSummary {
  sales: { count: number; total: number };
  moneyIn: { cash: number; card: number; check: number; other: number; total: number };
  storeCreditUsed: number;
  onAccount: number;
  /** `tenderKnown: false` until a refund-tender column exists: show only `total` */
  refunds: {
    count: number;
    cash: number;
    card: number;
    check: number;
    other: number;
    total: number;
    tenderKnown: boolean;
  };
  storeCreditIssued: { count: number; amount: number };
  cashExpectedInDrawer: number;
  netCollected: number;
}

export interface TodaysSalesResponse {
  data: TodaysSaleRow[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
    day: string;
    timezone: string;
    windowStart: string;
    windowEnd: string;
  };
  summary?: TodaysSalesSummary;
}

/** Under ["orders"], so a completed counter sale (which invalidates ["orders"]) refreshes the sheet with no extra wiring. */
export const COUNTER_SALE_TODAY_KEY = ["orders", "counter-sale-today"] as const;

export function useCounterSaleToday(enabled = true) {
  return useInfiniteQuery<TodaysSalesResponse>({
    queryKey: COUNTER_SALE_TODAY_KEY,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiClient
        .get<TodaysSalesResponse>("/orders/counter-sale/today", { params: { page: pageParam } })
        .then((r) => r.data),
    getNextPageParam: (last) =>
      last.meta.page < last.meta.totalPages ? last.meta.page + 1 : undefined,
    enabled,
  });
}
