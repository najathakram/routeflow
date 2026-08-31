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
 *   { product, source }        — found and sellable, with `source`
 *                                 indicating how
 *   { archived: true, product,
 *     source }                 — found, but the best match is inactive
 *                                 (F30/R5): distinct from both a plain hit
 *                                 and `notFound` — the caller must NOT
 *                                 silently add it
 *   { notFound: true }         — exhausted both paths
 *
 * Errors other than 404 (network / 5xx) propagate so the caller can show
 * a transient retry toast instead of falsely jumping to "not found".
 *
 * Who has to branch on `archived`: every caller that would COMMIT the product
 * — a sale/purchase line, a counted quantity, a pick handed to a builder. They
 * report `archivedMessage(...)` instead (lib/scan-ladder, the driver at-door
 * adjust, stock count, vendor bills, ProductPickerSheet). Callers that merely
 * NAVIGATE to the product or filter a read-only list (products/scan,
 * products/adjust-picker, movements) deliberately treat it as an ordinary hit:
 * reaching an archived product's own screen is how it gets reactivated, and
 * routing it to the `notFound` branch would offer "create new" for a product
 * that plainly exists.
 */
import { apiClient } from "./api-client";

export type BarcodeResolveSource = "barcode" | "sku" | "unitSku" | "search";

export interface BarcodeResolveHit<T = any> {
  product: T;
  source: BarcodeResolveSource;
  notFound?: false;
  archived?: false;
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
  /**
   * The SELLABLE rows the substring search returned. Only set when `ambiguous`.
   * Inactive rows are excluded (F30 / R5): the picker offers this list as
   * ordinary choices, and an archived row there would be added on one tap.
   */
  matches?: T[];
}

/**
 * F30 / R5: the best match on either rung resolved to a real product that is
 * `isActive: false`. Distinct from `BarcodeResolveHit` (never auto-add — the
 * caller must show the archived pill instead) and from `BarcodeResolveMiss`
 * (the product genuinely exists; "not found" would be a lie).
 */
export interface BarcodeResolveArchived<T = any> {
  archived: true;
  product: T;
  source: BarcodeResolveSource;
  notFound?: false;
  ambiguous?: false;
  matches?: undefined;
}

export interface BarcodeResolveMiss {
  notFound: true;
  product?: undefined;
  source?: undefined;
  archived?: false;
  ambiguous?: false;
  matches?: undefined;
}

export type BarcodeResolveResult<T = any> =
  BarcodeResolveHit<T> | BarcodeResolveArchived<T> | BarcodeResolveMiss;

/** Wrap a resolved product as a hit, or as `archived` when it's inactive. */
function asHit<T extends { isActive?: boolean | null }>(
  product: T,
  source: BarcodeResolveSource,
): BarcodeResolveHit<T> | BarcodeResolveArchived<T> {
  if (product?.isActive === false) {
    return { archived: true, product, source };
  }
  return { product, source };
}

/**
 * The one line every surface shows for an `archived` outcome. Shared so the
 * driver adjust screen, stock count, vendor bills and the picker sheet can't
 * drift from each other — and so none of them falls back to "no product",
 * which is the lie R5 exists to kill. (`lib/scan-ladder` keeps its own
 * sale-specific "reactivate to sell" wording on the scan pill.)
 */
export function archivedMessage(product: { name?: string | null } | undefined): string {
  return `${product?.name || "Item"} is archived — reactivate it first`;
}

/**
 * `signal` cancels BOTH rungs (they run sequentially, so one signal covers the
 * whole ladder). The scan path passes the camera's per-scan deadline through it
 * — without a real abort a slow lookup keeps running after the caller has given
 * up and still adds the product (F30 / R2).
 */
export async function resolveProductByCode<T = any>(
  rawCode: string,
  signal?: AbortSignal,
): Promise<BarcodeResolveResult<T>> {
  const code = rawCode.trim();
  if (!code) return { notFound: true };

  // 1) Exact barcode match
  try {
    const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`, { signal });
    if (res.data?.id) {
      // The API's findByBarcode intentionally matches inactive products too
      // (no isActive filter) — align with that instead of silently adding an
      // archived item (F30 / R5).
      return asHit(res.data, "barcode");
    }
  } catch (err: any) {
    // 404 → keep going. Anything else (network / 5xx) bubbles up.
    const status = err?.response?.status;
    if (status !== 404) throw err;
  }

  // 2 + 3) SKU / unit-code / name substring search; prefer exact SKU, then exact
  // unit code. `scanCode` (not `search`): the server fans the normalizeScanCode
  // CANDIDATES into the contains-match, so this rung is decoder-independent —
  // an iOS 13-digit decode still finds a 12-digit code stored in the product
  // NAME (numeric-name catalogues), which `search=<raw>` contains-missed.
  // No `isActive` filter here either (F30 / R5) — this rung must agree with
  // the barcode rung on archived products instead of independently reporting
  // `notFound` for something that genuinely exists. Inactive rows now compete
  // for the window, so widen it: at 10 a numeric-name catalogue could push the
  // one sellable match out and report `notFound` for a product on the shelf.
  try {
    const res = await apiClient.get("/products", {
      params: { scanCode: code, limit: 20, includeVariants: true },
      signal,
    });
    const matches: any[] = res?.data?.data ?? res?.data ?? [];
    if (matches.length > 0) {
      const codeLower = code.toLowerCase();
      const skuExact = matches.find((p) => (p?.sku ?? "").toString().toLowerCase() === codeLower);
      if (skuExact) return asHit(skuExact, "sku");
      const unitSkuExact = matches.find(
        (p) => (p?.unitSku ?? "").toString().toLowerCase() === codeLower,
      );
      if (unitSkuExact) return asHit(unitSkuExact, "unitSku");
      // This rung no longer filters `isActive`, so archived rows land in the
      // substring set — and the ambiguity list is a PICKER, where every row is
      // one tap from the order. Classify it the same way `asHit` classifies a
      // single match: the sellable rows decide the outcome, and a set that is
      // archived top to bottom is an `archived` outcome, not a silent guess.
      const sellable = matches.filter((p) => p?.isActive !== false);
      if (sellable.length === 0) return asHit(matches[0], "search");
      // One substring hit is safe to take. More than one is a guess — flag it
      // so the caller can offer a choice rather than commit to row #1.
      if (sellable.length === 1) return asHit(sellable[0], "search");
      return { product: sellable[0], source: "search", ambiguous: true, matches: sellable };
    }
  } catch (err: any) {
    const status = err?.response?.status;
    // Search 404 shouldn't happen, but treat it as "no match" rather than fail
    if (status !== 404) throw err;
  }

  return { notFound: true };
}
