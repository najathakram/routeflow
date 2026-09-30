import { Badge } from "@routeflow/ui/web";

export type ProductStatus = "IN_STOCK" | "LOW" | "OUT_OF_STOCK" | "INACTIVE";
export type ProductStockFilter = "" | "IN_STOCK" | "LOW" | "OUT_OF_STOCK" | "INACTIVE";

/** An inactive product is its own status — never folded into "Out of Stock" (WS7). */
export function getProductStatus(p: { isActive: boolean; currentStock: number }): ProductStatus {
  if (!p.isActive) return "INACTIVE";
  if (p.currentStock <= 0) return "OUT_OF_STOCK";
  if (p.currentStock <= 5) return "LOW";
  return "IN_STOCK";
}

/**
 * The list/export query params for a filter chip. "Inactive" is `isActive=false` and sends no
 * stockStatus: the server's stock filters force isActive=true, so combining them would return nothing.
 */
export function stockFilterParams(filter: ProductStockFilter): {
  stockStatus?: "IN_STOCK" | "LOW" | "OUT_OF_STOCK";
  isActive?: false;
} {
  if (filter === "INACTIVE") return { isActive: false };
  if (filter) return { stockStatus: filter };
  return {};
}

export function ProductStatusBadge({ status }: { status: ProductStatus }) {
  if (status === "INACTIVE") return <Badge variant="neutral" label="Inactive" />;
  if (status === "OUT_OF_STOCK") return <Badge variant="danger" label="Out of Stock" />;
  if (status === "LOW") return <Badge variant="warning" label="Low Stock" />;
  return <Badge variant="success" label="In Stock" />;
}
