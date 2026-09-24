import type { ProductUnitLevel } from "@routeflow/types";
import { apiClient } from "./api-client";
import { decideResumeLine } from "./order-draft-logic";
import type { Product } from "./cart-line-state";

/**
 * B747 (SA-085a): fetches the live product (and, for a unit-labeled parked line, its live unit
 * ladder) for one parked draft line, so NewOrderScreen's hydration effect can re-resolve pricing
 * off LIVE data rather than the parked snapshot. NOT pure (does I/O) — kept out of
 * order-draft-logic.ts, which stays pure/no-fetch so its decisions can be pinned directly.
 * __tests__/resume-draft-hydration.test.ts pins the units-fetch failure classification (R1)
 * directly, with a mocked apiClient; the screen's own wiring is still pinned separately.
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
      } catch (err) {
        const status = (err as { response?: { status?: number } })?.response?.status;
        // R1 (Opus REQUIRED, B747): a genuine non-404 failure (timeout, 5xx, 403 with
        // units_v1 off) must abort the WHOLE hydration exactly like a failed product
        // fetch — decideResumeLine's own rule, reused here — never silently treated as
        // "this product has no units," which falls back to pack pricing and can sell a
        // Case as a pack (SA-101(d): an interactive path refuses an unknown, never
        // guesses; B606's $480->$42 shape).
        if (decideResumeLine<ProductUnitLevel[]>({ ok: false, status }).failed) {
          return { li, product: null, failed: true, units: [] };
        }
        units = [];
      }
    }
    return { li, ...decided, units };
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    return { li, ...decideResumeLine<Product>({ ok: false, status }), units: [] };
  }
}
