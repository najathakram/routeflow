import { displayProductName, PRODUCT_NAME_SEPARATOR } from "@routeflow/types/api/product-name";
import type { DisplayProductLike } from "@routeflow/types/api/product-name";

// SA-1216: the rule lives in `@routeflow/types` (one copy for web and mobile); re-exported so every
// existing call site keeps its import.
export { displayProductName, PRODUCT_NAME_SEPARATOR };
export type { DisplayProductLike };

/**
 * The name to show for an order line on any READ surface (order detail, split-invoice picker…).
 * A catalog variant stores only its own flavor in `Product.name`, and the composed
 * "<Parent> - <Variant>" the operator saw while building the order is never persisted (the create
 * payload sends only `productId`), so every read has to re-compose it. Ad-hoc lines carry their
 * label in `line.name`. Returns null when neither exists so each caller keeps its own fallback.
 */
export function orderLineName(line: {
  product?: DisplayProductLike | null;
  name?: string | null;
}): string | null {
  if (line.product) return displayProductName(line.product) || line.name || null;
  return line.name ?? null;
}

/**
 * Where a row may break a long product name (display only — never derive or store data from it).
 * The catalog convention is "<family> - <distinguishing part>" (`PRODUCT_NAME_SEPARATOR`), e.g.
 * "Sample Pod - Strawberry Banana - 5ct". `stem` is the shared family and may be clamped;
 * `anchor` is everything after the FIRST separator — the flavor / pack size a picker tells two
 * SKUs apart by — and must never be clamped. A name with no separator has no stem: the whole
 * string is the anchor and the caller clamps it as a plain name.
 *
 * (order-ui-redesign-spec §3.2 words this as "the last segment", but its own §3.3 mockup keeps
 * "BERRY BLAST SATIVA - 20CT" together as the anchor; splitting at the first separator is the
 * reading that keeps both the flavor and the pack size unclamped.)
 */
export function splitProductName(name: string): { stem: string | null; anchor: string } {
  const at = name.indexOf(PRODUCT_NAME_SEPARATOR);
  if (at <= 0) return { stem: null, anchor: name };
  const stem = name.slice(0, at).trim();
  const anchor = name.slice(at + PRODUCT_NAME_SEPARATOR.length).trim();
  if (!stem || !anchor) return { stem: null, anchor: name };
  return { stem, anchor };
}
