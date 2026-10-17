import { effectiveQty } from "@routeflow/pricing";
import { toNumber, type LineState, type Product } from "./cart-line-state";
import type { DraftCatalogLine } from "./drafts-payload";
import { displayProductName as displayName } from "./product-display";

/**
 * The parked-draft catalog lines (extracted verbatim from NewOrderScreen.tsx's `draftCatalogLines` memo, size-ratchet):
 * the CURRENT effective price/qty per line, in the shape drafts-payload.ts parks. Every money value flows through
 * computeLineSubtotal elsewhere (never re-derived here); the three price callbacks are the screen's layer-bound ones.
 */
export function buildDraftCatalogLines(
  items: Record<string, LineState>,
  productById: Map<string, Product>,
  {
    lineSpecialFor,
    tierPriceFor,
    lineBaseFor,
  }: {
    lineSpecialFor: (line: LineState | undefined, p: Product) => boolean;
    tierPriceFor: (p: Product) => number;
    lineBaseFor: (line: LineState, p: Product) => number;
  },
): DraftCatalogLine[] {
  const lines: DraftCatalogLine[] = [];
  for (const [productId, line] of Object.entries(items)) {
    const p = productById.get(productId);
    if (!p) continue;
    const qty = effectiveQty(line, p.unitsPerBox);
    if (qty <= 0) continue;
    const special = lineSpecialFor(line, p);
    const tierPrice = tierPriceFor(p);
    const listPrice = toNumber(p.pricePerUnit);
    // B747: a unit-sold line's comparison base is its OWN resolved price, never the pack's
    // tier price — same fix as lineUnitFor/computeOrderTotal (lib/cart-order-total.ts). Before
    // this, a parked unit line was written to the wire as a plain STANDARD/pack line (no
    // unitLabel at all), so this screen's own drafts never actually carried the field the old
    // whole-draft resume refusal keyed on — that refusal only ever fired for a draft parked by
    // a different client.
    const priceBase = lineBaseFor(line, p);
    // Mobile has no separate "permanent discount" concept — any explicit
    // override the operator set is tagged MANUAL (never DISCOUNTED), which
    // is exactly what the resume-hydration pin rule above checks for.
    // #2696(c): a special line's override parks only WITH its reason (as submit sends it).
    const hasOverride =
      (!special || !!line.overrideReason?.trim()) &&
      line.unitPrice != null &&
      line.unitPrice !== priceBase;
    lines.push({
      productId,
      productName: displayName(p),
      unit: p.unit ?? "each",
      listPrice,
      ...(special ? { specialPrice: tierPrice } : {}),
      ...(hasOverride ? { discountedPrice: line.unitPrice } : {}),
      ...(hasOverride && line.overrideReason ? { overrideReason: line.overrideReason } : {}),
      unitPrice: hasOverride ? line.unitPrice! : priceBase,
      priceType: hasOverride ? "MANUAL" : special ? "SPECIAL" : "STANDARD",
      qty,
      ...(p.unitsPerBox ? { unitsPerBox: Number(p.unitsPerBox) } : {}),
      ...(line.boxes != null ? { boxes: line.boxes } : {}),
      ...(line.pieces != null ? { pieces: line.pieces } : {}),
      ...(line.unitLabel ? { unitLabel: line.unitLabel } : {}),
      ...(line.derivedBase ? { derivedBase: line.derivedBase } : {}),
      ...(hasOverride && line.priceSource ? { priceSource: line.priceSource } : {}),
      ...(p.averageCost != null
        ? { unitCost: toNumber(p.averageCost) }
        : p.standardCost != null
          ? { unitCost: toNumber(p.standardCost) }
          : {}),
      ...(p.category ? { category: p.category } : {}),
      ...(line.note?.trim() ? { note: line.note.trim() } : {}),
    });
  }
  return lines;
}
