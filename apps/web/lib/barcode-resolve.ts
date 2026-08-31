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
 * Returns `{ archived: true, product, source }` when the best match exists but
 * is inactive (F30 / R5) — distinct from both a plain hit and `notFound`, and
 * never silently committed. Mirrors apps/mobile/lib/barcode-resolve.ts; the two
 * rungs must agree about archived products or the same scan reads as "added"
 * here and "archived" on mobile.
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
  archived?: false;
  /** True when several substring hits matched with no exact code match —
   *  `product` is the first row, `matches` carries the alternatives so the
   *  caller can offer a choice instead of committing to row #1 (mirrors
   *  apps/mobile/lib/barcode-resolve.ts). Inactive rows are excluded: the
   *  alternatives are a picker, and an archived row there would be added on
   *  one click. */
  ambiguous?: boolean;
  matches?: T[];
}

/**
 * F30 / R5: the best match on either rung is a real product with
 * `isActive: false`. Never auto-added (the caller says so instead), and never
 * reported as `notFound` — the product plainly exists.
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
  ambiguous?: undefined;
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
 * The one line every surface shows for an `archived` outcome, so the scan
 * screens can't drift from each other — and so none of them falls back to "no
 * product", which is the lie R5 exists to kill. Mirrors mobile's export of the
 * same name.
 */
export function archivedMessage(product: { name?: string | null } | undefined): string {
  return `${product?.name || "Item"} is archived — reactivate it first`;
}

export async function resolveProductByCode<T = any>(
  rawCode: string,
): Promise<BarcodeResolveResult<T>> {
  const code = rawCode.trim();
  if (!code) return { notFound: true };

  // 1) Exact barcode match
  try {
    const res = await apiClient.get(`/products/barcode/${encodeURIComponent(code)}`);
    if (res.data?.id) {
      // The API's findByBarcode intentionally matches inactive products too
      // (no isActive filter) — align with that instead of silently adding an
      // archived item (F30 / R5).
      return asHit(res.data, "barcode");
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
  // No `isActive` filter here either (F30 / R5) — this rung must agree with the
  // barcode rung on archived products instead of independently reporting
  // `notFound` for something that genuinely exists. Inactive rows now compete
  // for the window, so widen it: at 10 a numeric-name catalogue could push the
  // one sellable match out and report `notFound` for a product on the shelf.
  try {
    const res = await apiClient.get("/products", {
      params: { scanCode: code, limit: 20, includeVariants: true },
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
      // Archived rows land in the substring set now, and the ambiguity list is a
      // PICKER where every row is one click from the order. Classify it the way
      // `asHit` classifies a single match: the sellable rows decide the outcome,
      // and a set that is archived top to bottom is an `archived` outcome.
      const sellable = matches.filter((p) => p?.isActive !== false);
      if (sellable.length === 0) return asHit(matches[0], "search");
      if (sellable.length === 1) return asHit(sellable[0], "search");
      return { product: sellable[0], source: "search", ambiguous: true, matches: sellable };
    }
  } catch (err: any) {
    const status = err?.response?.status;
    if (status !== 404) throw err;
  }

  return { notFound: true };
}
