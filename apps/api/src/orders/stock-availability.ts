import { resolveOversellAllowed, type OversellPolicyReader } from "./oversell-policy";
import type { JwtPayload } from "../auth/jwt-payload.interface";

/** Hard cap on one lookup — a New Order never has more lines than this in practice. */
export const MAX_STOCK_AVAILABILITY_IDS = 200;

export interface StockAvailability {
  /** The SAME boolean the save path resolves: true = an over-stock line is accepted, false = refused. */
  allowOversell: boolean;
  /** `Product.currentStock` in PIECES — the number `decrementStockForSale` compares a line's pieces to. */
  items: Array<{ productId: string; availablePieces: number }>;
}

/**
 * Read-only "live stock per line" lookup for the order screens. It computes nothing of its own:
 * availability is `Product.currentStock` (pieces, order-stock.ts) and the policy is
 * `resolveOversellAllowed` with the same source the save uses — "staff_entry" when creating,
 * "edit" when editing an existing order.
 */
export async function getStockAvailability(args: {
  productIds: string[];
  user: Pick<JwtPayload, "tenantId" | "role">;
  mode: "entry" | "edit";
  customerId?: string | null;
  products: { findMany: (q: any) => Promise<Array<{ id: string; currentStock: unknown }>> };
  oversellReader: OversellPolicyReader;
}): Promise<StockAvailability> {
  const ids = [...new Set(args.productIds.filter(Boolean))].slice(0, MAX_STOCK_AVAILABILITY_IDS);
  const rows = ids.length
    ? await args.products.findMany({
        where: { id: { in: ids } },
        select: { id: true, currentStock: true },
      })
    : [];
  const allowOversell = await resolveOversellAllowed(args.oversellReader, {
    tenantId: args.user.tenantId as string,
    role: args.user.role,
    source: args.mode === "edit" ? "edit" : "staff_entry",
    customerId: args.customerId,
  });
  return {
    allowOversell,
    items: rows.map((r) => ({ productId: r.id, availablePieces: Number(r.currentStock) })),
  };
}
