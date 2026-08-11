/**
 * Resolve a scanned barcode (or typed SKU/unit code) to a product, with the
 * same fallback ladder the web operator uses on /orders and /invoices/new:
 *
 *   1. Exact `Product.barcode`/`sku`/`unitSku` match — `/products/barcode/<code>`
 *      (the server endpoint itself resolves any of the three codes)
 *   2. Exact `Product.sku` or `Product.unitSku` match (case-insens),
 *      SKU preferred                              — `/products?search=<code>`
 *   3. First name/SKU substring hit                — same search, first row
 *   4. Nothing                                     — caller decides (usually
 *                                                    prompt to create a new
 *                                                    product with the scanned
 *                                                    code prefilled as SKU)
 *
 * Why: the bare `/products/barcode/<code>` lookup ONLY matches when the
 * tenant has assigned that exact string to `Product.barcode`, `sku`, or
 * `unitSku`. Most recently-added items don't have a barcode set yet — the
 * operator scans the printed SKU/unit-code label and the lookup 404s, so the
 * mobile UI tells them "item not available" even though the product exists.
 *
 * Returns:
 *   { product, source }     — found, with `source` indicating how
 *   { notFound: true }      — exhausted both paths
 *
 * Errors other than 404 (network / 5xx) propagate so the caller can show
 * a transient retry toast instead of falsely jumping to "not found".
 */
import { apiClient } from "./api-client";

export type BarcodeResolveSource = "barcode" | "sku" | "unitSku" | "search";

export interface BarcodeResolveHit<T = any> {
  product: T;
  source: BarcodeResolveSource;
  notFound?: false;
  /**
   * The substring search returned MORE THAN ONE row and none was an exact
   * sku/unitSku hit, so `product` is a guess (the first row by name).
   *
   * `product` is still populated so existing callers keep working unchanged,
   * but a caller that can show a list SHOULD branch on this instead of silently
   * adding the wrong line — with numeric product names, a 12-digit scan
   * substring-matches broadly.
   */
  ambiguous?: boolean;
  /** Every row the substring search returned. Only set when `ambiguous`. */
  matches?: T[];
}

export interface BarcodeResolveMiss {
  notFound: true;
  product?: undefined;
  source?: undefined;
  ambiguous?: false;
  matches?: undefined;
}

export type BarcodeResolveResult<T = any> = BarcodeResolveHit<T> | BarcodeResolveMiss;

export async function resolveProductByCode<T = any>(
  rawCode: string,
): Promise<BarcodeResolveResult<T>> {
  const code = rawCode.trim();
  if (!code) return { notFound: true };

  // 1) Exact barcode match
  try {
    const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
    if (res.data?.id) {
      return { product: res.data, source: "barcode" };
    }
  } catch (err: any) {
    // 404 → keep going. Anything else (network / 5xx) bubbles up.
    const status = err?.response?.status;
    if (status !== 404) throw err;
  }

  // 2 + 3) SKU / unit-code / name substring search; prefer exact SKU, then exact unit code
  try {
    const res = await apiClient.get("/products", {
      params: { search: code, limit: 10, isActive: true, includeVariants: true },
    });
    const matches: any[] = res?.data?.data ?? res?.data ?? [];
    if (matches.length > 0) {
      const codeLower = code.toLowerCase();
      const skuExact = matches.find((p) => (p?.sku ?? "").toString().toLowerCase() === codeLower);
      if (skuExact) return { product: skuExact, source: "sku" };
      const unitSkuExact = matches.find(
        (p) => (p?.unitSku ?? "").toString().toLowerCase() === codeLower,
      );
      if (unitSkuExact) return { product: unitSkuExact, source: "unitSku" };
      // One substring hit is safe to take. More than one is a guess — flag it
      // so the caller can offer a choice rather than commit to row #1.
      if (matches.length === 1) return { product: matches[0], source: "search" };
      return { product: matches[0], source: "search", ambiguous: true, matches };
    }
  } catch (err: any) {
    const status = err?.response?.status;
    // Search 404 shouldn't happen, but treat it as "no match" rather than fail
    if (status !== 404) throw err;
  }

  return { notFound: true };
}
