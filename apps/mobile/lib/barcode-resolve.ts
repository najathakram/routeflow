/**
 * Resolve a scanned barcode (or typed SKU) to a product, with the same
 * fallback ladder the web operator uses on /orders and /invoices/new:
 *
 *   1. Exact `Product.barcode` match           — `/products/barcode/<code>`
 *   2. Exact `Product.sku` match (case-insens) — `/products?search=<code>`
 *   3. First name/SKU substring hit             — same search, first row
 *   4. Nothing                                  — caller decides (usually
 *                                                 prompt to create a new
 *                                                 product with the scanned
 *                                                 code prefilled as SKU)
 *
 * Why: the bare `/products/barcode/<code>` lookup ONLY matches when the
 * tenant has assigned that exact string to `Product.barcode`. Most
 * recently-added items don't have a barcode set yet — the operator
 * scans the printed SKU label and the lookup 404s, so the mobile UI
 * tells them "item not available" even though the product exists.
 *
 * Returns:
 *   { product, source }     — found, with `source` indicating how
 *   { notFound: true }      — exhausted both paths
 *
 * Errors other than 404 (network / 5xx) propagate so the caller can show
 * a transient retry toast instead of falsely jumping to "not found".
 */
import { apiClient } from "./api-client";

export type BarcodeResolveSource = "barcode" | "sku" | "search";

export interface BarcodeResolveHit<T = any> {
  product: T;
  source: BarcodeResolveSource;
  notFound?: false;
}

export interface BarcodeResolveMiss {
  notFound: true;
  product?: undefined;
  source?: undefined;
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

  // 2 + 3) SKU / name substring search; prefer exact SKU
  try {
    const res = await apiClient.get("/products", {
      params: { search: code, limit: 10, isActive: true, includeVariants: true },
    });
    const matches: any[] = res?.data?.data ?? res?.data ?? [];
    if (matches.length > 0) {
      const skuExact = matches.find(
        (p) => (p?.sku ?? "").toString().toLowerCase() === code.toLowerCase(),
      );
      const product = skuExact ?? matches[0];
      return { product, source: skuExact ? "sku" : "search" };
    }
  } catch (err: any) {
    const status = err?.response?.status;
    // Search 404 shouldn't happen, but treat it as "no match" rather than fail
    if (status !== 404) throw err;
  }

  return { notFound: true };
}
