import type { ProductUnitLevel } from "@routeflow/types";
import { apiClient } from "./api-client";
import { decideResumeLine } from "./order-draft-logic";
import type { Product } from "./cart-line-state";

/**
 * B747 (SA-085a): fetches the live product (and, for a unit-labeled parked line, its live unit
 * ladder) for one parked draft line, so NewOrderScreen's hydration effect can re-resolve pricing
 * off LIVE data rather than the parked snapshot. NOT pure (does I/O) — kept out of
 * order-draft-logic.ts, which stays pure/no-fetch so its decisions can be pinned directly; this
 * file has no dedicated pins of its own, only tsc + the screen's own wiring pin.
 */
export async function hydrateParkedLine<
  Li extends { productId: string; unitLabel?: string | null },
>(
  li: Li,
): Promise<{
  li: Li;
  product: Product | null;
  failed: boolean;
  units: ProductUnitLevel[];
}> {
  try {
    const { data } = await apiClient.get<Product>(`/products/${li.productId}`);
    const decided = decideResumeLine<Product>({ ok: true, product: data });
    let units: ProductUnitLevel[] = [];
    if (li.unitLabel && decided.product) {
      try {
        const unitsRes = await apiClient.get<ProductUnitLevel[]>(`/products/${li.productId}/units`);
        units = unitsRes.data;
      } catch {
        units = [];
      }
    }
    return { li, ...decided, units };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    return { li, ...decideResumeLine<Product>({ ok: false, status }), units: [] };
  }
}
