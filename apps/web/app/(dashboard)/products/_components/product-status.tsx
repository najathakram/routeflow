import { Badge } from "@routeflow/ui/web";
import { formatQty } from "@/lib/format";

export type ProductStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK" | "INACTIVE";
export type ProductStockFilter = "" | "IN_STOCK" | "LOW" | "OUT_OF_STOCK" | "INACTIVE";

/** An inactive product is its own status — never folded into "Out of Stock" (WS7). */
export function getProductStatus(p: { isActive: boolean; currentStock: number }): ProductStatus {
  if (!p.isActive) return "INACTIVE";
  if (p.currentStock <= 0) return "OUT_OF_STOCK";
  if (p.currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

export const STOCK_FILTER_CHIPS: ReadonlyArray<{ value: ProductStockFilter; label: string }> = [
  { value: "", label: "All" },
  { value: "IN_STOCK", label: "In Stock" },
  { value: "LOW", label: "Low Stock" },
  { value: "OUT_OF_STOCK", label: "Out of Stock" },
  { value: "INACTIVE", label: "Inactive" },
];

/**
 * The list/export query params for a filter chip. "Inactive" is `isActive=false` with no stockStatus
 * (the server's IN_STOCK/LOW filters force isActive=true, so combining would return nothing). The
 * server's OUT_OF_STOCK filter is `isActive=false OR currentStock<=0`, so that chip pins
 * `isActive=true` or inactive products would leak in and wear the Inactive badge.
 */
export function stockFilterParams(filter: ProductStockFilter): {
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  isActive?: boolean;
} {
  if (filter === "INACTIVE") return { isActive: false };
  if (filter === "OUT_OF_STOCK") return { stockStatus: "OUT_OF_STOCK", isActive: true };
  if (filter) return { stockStatus: filter };
  return {};
}

/**
 * Row 330b (owner ruling): an empty product shows the real count in the warning tone ("0 in stock"), never a red
 * "Out of Stock". The product stays sellable; the count is the whole message. The ONE formatter for every staff badge
 * site: a negative count never reads "-2 in stock", it clamps to 0 and says how many were sold past it.
 */
export function stockCountLabel(currentStock: number | null | undefined): string {
  const n = Number(currentStock ?? 0);
  if (Number.isFinite(n) && n < 0) return `0 in stock · ${formatQty(-n)} oversold`;
  return `${formatQty(n)} in stock`;
}

export function ProductStatusBadge({
  status,
  currentStock,
}: {
  status: ProductStatus;
  currentStock?: number | null;
}) {
  if (status === "INACTIVE") return <Badge variant="neutral" label="Inactive" />;
  if (status === "OUT_OF_STOCK")
    return <Badge variant="warning" label={stockCountLabel(currentStock)} />;
  if (status === "LOW") return <Badge variant="warning" label="Low Stock" />;
  return <Badge variant="success" label="In Stock" />;
}
