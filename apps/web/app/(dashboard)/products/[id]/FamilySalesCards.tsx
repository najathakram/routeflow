"use client";

import * as React from "react";
import { useProductSales } from "@/lib/api/product-sales";
import { DemandCard } from "./DemandCard";
import { SalesHistoryCard } from "./SalesHistoryCard";

/**
 * K11-25: a family's Demand and Sales cards. Both look the product up by its own id, so a family (which is never
 * invoiced) used to show two cards that each said "Never sold". Now there is one empty state: while the sales load,
 * on an error, or when there are none, only Sales renders (compact, with copy that is true of a family). Demand
 * comes back as soon as there is history to chart (a product that became a family keeps its old sales).
 * `useProductSales` shares the Sales card's query key, so this is no extra request.
 */
export function FamilySalesCards({
  productId,
  unitsPerBox,
}: {
  productId: string;
  unitsPerBox: number | null | undefined;
}) {
  const { data } = useProductSales(productId);
  const hasHistory = !!data && data.summary.count > 0;
  return (
    <>
      {hasHistory && <DemandCard productId={productId} unitsPerBox={unitsPerBox} />}
      <SalesHistoryCard productId={productId} hideCreateOrder compactEmpty />
    </>
  );
}
