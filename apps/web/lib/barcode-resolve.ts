/**
 * Resolve a scanned barcode (or typed SKU) to a product, with the same
 * fallback ladder used elsewhere (mobile + /orders + /invoices/new):
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
 * tenant has assigned that exact string to `Product.barcode`. Many
 * recently-added items don't have a barcode set yet — the operator
 * scans the printed SKU label and the lookup 404s.
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
  /** True when several substring hits matched with no exact code match —
   *  `product` is the first row, `matches` carries the alternatives so the
   *  caller can offer a choice instead of committing to row #1 (mirrors
   *  apps/mobile/lib/barcode-resolve.ts). */
  ambiguous?: boolean;
  matches?: T[];
}

export interface BarcodeResolveMiss {
  notFound: true;
  product?: undefined;
  source?: undefined;
  ambiguous?: undefined;
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
    const status = err?.response?.status;
    if (status !== 404) throw err;
  }

  // 2 + 3) SKU / unit-code / name substring search; prefer exact SKU, then exact
  // unit code. `scanCode` (not `search`): the server fans the normalizeScanCode
  // CANDIDATES into the contains-match, so this rung is decoder-independent —
  // an iOS 13-digit decode still finds a 12-digit code stored in the product
  // NAME (numeric-name catalogues), which `search=<raw>` contains-missed.
  try {
    const res = await apiClient.get("/products", {
      params: { scanCode: code, limit: 10, isActive: true, includeVariants: true },
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
      if (matches.length === 1) return { product: matches[0], source: "search" };
      return { product: matches[0], source: "search", ambiguous: true, matches };
    }
  } catch (err: any) {
    const status = err?.response?.status;
    if (status !== 404) throw err;
  }

  return { notFound: true };
}
