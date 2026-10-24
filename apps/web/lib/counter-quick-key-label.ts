import type { QuickKey } from "@routeflow/types";
import { displayProductName, type DisplayProductLike } from "./product-display";

/**
 * What a quick key and the editor call a product. A variant's own `name` column holds only the variant part, so two
 * "Strawberry" keys of different brands would read the same: the key shows the full "Parent - Variant" name from its
 * scan-lookup product (the same helper the cart line uses).
 */
export function quickKeyLabel(k: Pick<QuickKey, "name" | "product">): string {
  const p = k.product as unknown as DisplayProductLike | undefined;
  return p && typeof p.name === "string" ? displayProductName(p) : k.name;
}
