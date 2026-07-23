/**
 * Pure matching logic for supplier-invoice scan lines. No Nest/Prisma imports —
 * the catalog and token weights are passed in, so specs run with zero mocks.
 *
 * Variants are separate Product rows whose `name` is the BARE variant name
 * ("Cinnamon"); matching always works on the COMPOSED display name
 * ("Big Red Chewing Gum - Cinnamon") so flavor lines land on the right sibling.
 * Rare (distinguishing) tokens — flavors, sizes — outweigh ubiquitous ones
 * ("gum", "chips") via document-frequency weights, which is what breaks
 * shared-prefix sibling ties correctly.
 */
export interface CatalogProduct {
  id: string;
  name: string;
  sku: string | null;
  barcode: string | null;
  unitSku?: string | null;
  parentProductId?: string | null;
  parent?: { name: string } | null;
}

export interface MatchCandidate {
  productId: string;
  /** Composed display name. */
  name: string;
  sku: string | null;
  /** Weighted-overlap score, 0..1, rounded to 2dp. */
  score: number;
}

export interface LineMatch {
  matchedProductId: string | null;
  matchedProductName: string | null;
  confidence: "high" | "medium" | "low" | "none";
  candidates?: MatchCandidate[];
}

/** Mirrors apps/web/lib/product-display.ts PRODUCT_NAME_SEPARATOR. */
const SEPARATOR = " - ";

export function composedProductName(p: CatalogProduct): string {
  const parentName = p.parent?.name?.trim();
  if (!p.parentProductId || !parentName) return p.name;
  // Legacy variants sometimes already carry the parent prefix — don't double it.
  if (p.name.toLowerCase().startsWith(parentName.toLowerCase())) return p.name;
  return `${parentName}${SEPARATOR}${p.name}`;
}

export function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokensOf(s: string): string[] {
  return normalizeForMatch(s)
    .split(" ")
    .filter((w) => w.length > 2);
}

/** Document-frequency token weights over the composed catalog names. */
export function buildTokenWeights(products: CatalogProduct[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const p of products) {
    for (const t of new Set(tokensOf(composedProductName(p)))) {
      df.set(t, (df.get(t) ?? 0) + 1);
    }
  }
  const weights = new Map<string, number>();
  for (const [t, n] of df) weights.set(t, 1 / Math.log2(2 + n));
  return weights;
}

function weightOf(t: string, weights: Map<string, number>): number {
  // A token the catalog has never seen (invoice-side noise) gets max weight so
  // it penalises the denominator — unknown words should LOWER confidence.
  return weights.get(t) ?? 1;
}

export function matchLine(
  raw: string,
  scannedSku: string | null | undefined,
  products: CatalogProduct[],
  weights: Map<string, number>,
): LineMatch {
  const rawTrim = (raw ?? "").trim();
  const rawLower = rawTrim.toLowerCase();
  // The scanned SKU arrives straight from the OCR JSON and may be a non-string
  // (a numeric item code, 0, or an array) despite the quoted-string schema —
  // coerce before any string op so a stray type can't throw and abort the scan.
  const skuStr = scannedSku == null ? "" : String(scannedSku).trim();
  const skuLower = skuStr.toLowerCase() || null;
  if (!rawLower && !skuLower) {
    return { matchedProductId: null, matchedProductName: null, confidence: "none" };
  }

  // 1. Exact name — bare OR composed.
  for (const p of products) {
    const composed = composedProductName(p);
    if (p.name.toLowerCase() === rawLower || composed.toLowerCase() === rawLower) {
      return { matchedProductId: p.id, matchedProductName: composed, confidence: "high" };
    }
  }

  // 2. Exact SKU / barcode — against the raw text (legacy behaviour) AND the
  //    scanned per-line item code.
  for (const p of products) {
    const pSku = p.sku?.toLowerCase() ?? null;
    const pUnit = p.unitSku?.toLowerCase() ?? null;
    if (
      (pSku && (pSku === rawLower || (skuLower && pSku === skuLower))) ||
      (pUnit && (pUnit === rawLower || (skuLower && pUnit === skuLower))) ||
      (p.barcode && (p.barcode === rawTrim || (skuStr && p.barcode === skuStr)))
    ) {
      return {
        matchedProductId: p.id,
        matchedProductName: composedProductName(p),
        confidence: "high",
      };
    }
  }

  // 3. Weighted fuzzy overlap vs composed names.
  const rawToks = tokensOf(rawTrim);
  if (rawToks.length === 0) {
    return { matchedProductId: null, matchedProductName: null, confidence: "none" };
  }
  const rawSet = new Set(rawToks);
  const rawWeight = [...rawSet].reduce((s, t) => s + weightOf(t, weights), 0);
  const scored: Array<{
    p: CatalogProduct;
    composed: string;
    score: number;
    hits: number;
    prefix: boolean;
  }> = [];
  for (const p of products) {
    const composed = composedProductName(p);
    const pToks = new Set(tokensOf(composed));
    if (pToks.size === 0) continue;
    let matched = 0;
    let hits = 0;
    let pWeight = 0;
    for (const t of pToks) {
      const w = weightOf(t, weights);
      pWeight += w;
      if (rawSet.has(t)) {
        matched += w;
        hits++;
      }
    }
    if (hits === 0) continue;
    const score = matched / Math.max(rawWeight, pWeight);
    const nc = normalizeForMatch(composed);
    const nr = normalizeForMatch(rawTrim);
    scored.push({ p, composed, score, hits, prefix: nc.startsWith(nr) || nr.startsWith(nc) });
  }
  // Deterministic ordering: score → raw hit count → exact-prefix → name asc.
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.hits - a.hits ||
      Number(b.prefix) - Number(a.prefix) ||
      a.composed.localeCompare(b.composed),
  );
  const candidates: MatchCandidate[] = scored
    .filter((s) => s.score >= 0.25)
    .slice(0, 5)
    .map((s) => ({
      productId: s.p.id,
      name: s.composed,
      sku: s.p.sku ?? null,
      score: Math.round(s.score * 100) / 100,
    }));
  const best = scored[0];
  if (best && best.score >= 0.6) {
    return {
      matchedProductId: best.p.id,
      matchedProductName: best.composed,
      confidence: best.score >= 0.8 ? "high" : "medium",
      ...(candidates.length ? { candidates } : {}),
    };
  }
  if (best && best.score >= 0.35) {
    // A weak guess is NOT auto-assigned — it is offered as suggestions. This is
    // the "weak matches get matched" fix: the line arrives unlinked, with chips.
    return { matchedProductId: null, matchedProductName: null, confidence: "low", candidates };
  }
  return {
    matchedProductId: null,
    matchedProductName: null,
    confidence: "none",
    ...(candidates.length ? { candidates } : {}),
  };
}
