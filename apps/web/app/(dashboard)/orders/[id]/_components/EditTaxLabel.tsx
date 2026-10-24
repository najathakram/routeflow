"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { apiClient } from "@/lib/api-client";
import { orderTaxLabel } from "@/lib/order-tax-label";

/**
 * Row 329a: the Tax row's label in the order edit panel's live total. The tenant's configured rate is `GET /settings`'
 * `taxRate` (the query every settings reader shares); until it is known, and whenever no stored rate corroborates one, the
 * label is plain "Tax" (see `orderTaxLabel`).
 */
export function EditTaxLabel({
  order,
}: {
  order: {
    subtotal: number | string;
    tax: number | string;
    invoices?: ReadonlyArray<{ status: string; items?: ReadonlyArray<{ taxRate?: unknown }> }>;
  };
}) {
  const { data: settings } = useQuery<{ taxRate?: number | null }>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
    staleTime: 60_000,
  });
  return (
    <span data-testid="edit-tax-label">
      {orderTaxLabel(order, order.invoices, settings?.taxRate)}
    </span>
  );
}
