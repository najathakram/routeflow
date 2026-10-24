import type { ResumeLine } from "./resume";

/**
 * SA-817a: re-pricing a resumed order must show TODAY's price, so it reads each product's current tier columns (the existing
 * `GET /products/:id`, no new endpoint) rather than trusting the snapshot parked with the line: a tier-column change since the
 * order was started would otherwise show the old price and bill the new one. Reads run in parallel with a cap; a failed read
 * never blocks the resume (the line keeps what it had and the screen says prices were not refreshed).
 */
export const PRICE_FETCH_CONCURRENCY = 8;

export const PRICES_NOT_REFRESHED_COPY =
  "Prices not refreshed. They are checked again when you submit.";

/** The product columns `customerLinePrice` prices from. */
export interface TierColumns {
  pricePerUnit: unknown;
  priceTier2?: unknown;
  priceTier3?: unknown;
  priceTier4?: unknown;
  priceTier5?: unknown;
}

export interface FreshPrices {
  /** productId -> its current tier columns, for every read that succeeded. */
  byProduct: Map<string, TierColumns>;
  /** At least one read failed (offline, 5xx, a deleted product): those lines were not refreshed. */
  failed: boolean;
}

/** Products worth reading: catalog lines that re-price from the pack's tier columns and carry no staff override. */
export function productsToRefresh(lines: readonly ResumeLine[]): string[] {
  const ids = new Set<string>();
  for (const li of lines) {
    if (li.isUnlisted || li.unitLabel || !li.productId) continue;
    if (li.priceType === "DISCOUNTED" || li.discountedPrice != null) continue;
    ids.add(li.productId);
  }
  return Array.from(ids);
}

export async function fetchCurrentTierPrices(
  productIds: readonly string[],
  read: (productId: string) => Promise<TierColumns>,
  concurrency: number = PRICE_FETCH_CONCURRENCY,
): Promise<FreshPrices> {
  const byProduct = new Map<string, TierColumns>();
  let failed = false;
  let next = 0;
  const worker = async () => {
    while (next < productIds.length) {
      const id = productIds[next++];
      try {
        const p = await read(id);
        if (p && typeof p === "object" && "pricePerUnit" in p) byProduct.set(id, p);
        else failed = true;
      } catch {
        failed = true;
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(Math.max(1, concurrency), productIds.length) }, worker),
  );
  return { byProduct, failed };
}

/** The lines with the freshly read tier columns swapped in (a line whose read failed keeps its snapshot). */
export function withFreshTierPrices<T extends ResumeLine>(
  lines: readonly T[],
  fresh: ReadonlyMap<string, TierColumns>,
): T[] {
  return lines.map((li) => {
    const cols = fresh.get(li.productId);
    if (!cols || li.isUnlisted || li.unitLabel) return li;
    return {
      ...li,
      tierPrices: {
        pricePerUnit: cols.pricePerUnit,
        priceTier2: cols.priceTier2,
        priceTier3: cols.priceTier3,
        priceTier4: cols.priceTier4,
        priceTier5: cols.priceTier5,
      },
    };
  });
}
