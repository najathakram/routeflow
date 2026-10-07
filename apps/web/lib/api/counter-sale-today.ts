// Mirrors POS-7b-1 API contract; dedupe into @routeflow/types at train time.
// `GET /orders/counter-sale/today?page=N`: today's counter sales, newest first, page 1 also carries the summary.
import { useInfiniteQuery } from "@tanstack/react-query";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import { apiClient } from "../api-client";

export interface CounterSaleTodayRow {
  orderId: string;
  invoiceId: string;
  /** the receipt number the clerk reads out: the order number */
  orderNumber: string;
  invoiceNumber: string;
  /** ISO time of the sale */
  soldAt: string;
  total: number;
  paid: number;
  balanceDue: number;
  /** the tenders on the sale; empty or ON_ACCOUNT only = left on account */
  methods: CounterSalePaymentMethod[];
  returnState: "NONE" | "PARTIAL" | "FULL";
  customerName: string | null;
  walkIn: boolean;
  /** a cancelled sale: shown struck through, no Return action */
  voided: boolean;
}

export interface CounterSaleTodaySummary {
  sales: { count: number; total: number };
  /** money taken in, by tender (on-account sales take no money in) */
  moneyIn: { cash: number; card: number; check: number };
  /** `tenderKnown: false` until a refund-tender column exists: only the single total is meaningful, all in `other` */
  refunds: { cash: number; card: number; check: number; other: number; tenderKnown: boolean };
  cashExpected: number;
}

export interface CounterSaleTodayPage {
  rows: CounterSaleTodayRow[];
  page: number;
  /** the next page number, or null on the last page */
  nextPage: number | null;
  /** page 1 only */
  summary?: CounterSaleTodaySummary;
}

/** Under ["orders"], so a completed counter sale (which invalidates ["orders"]) refreshes the sheet with no extra wiring. */
export const COUNTER_SALE_TODAY_KEY = ["orders", "counter-sale-today"] as const;

export function useCounterSaleToday(enabled = true) {
  return useInfiniteQuery<CounterSaleTodayPage>({
    queryKey: COUNTER_SALE_TODAY_KEY,
    initialPageParam: 1,
    queryFn: ({ pageParam }) =>
      apiClient
        .get<CounterSaleTodayPage>("/orders/counter-sale/today", { params: { page: pageParam } })
        .then((r) => r.data),
    getNextPageParam: (last) => last.nextPage ?? undefined,
    enabled,
  });
}
