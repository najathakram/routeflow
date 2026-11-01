import { productDisplayName, type DisplayNameProduct } from "../products/product-display-name";

/**
 * A family variant stores only its own label ("Classic"), which means nothing on an invoice line. A line reads
 * "<Family> - <Variant>" (`productDisplayName`, the same separator and double-prefix guard as web and mobile). Two
 * directions, one rule:
 *
 *  - WRITE (`lineProductName`): a NEW line stores the composed name, from the product and its family.
 *  - READ (`withFamilyNames`): an EXISTING line is composed on the way out, but only when its stored description is still
 *    the product's bare name or variant label. A description someone typed over it is left alone. Nothing is written
 *    back: the send fingerprint hashes the stored text (`invoice-send-state.ts`), so a rewrite would show every sent
 *    invoice as changed since sent.
 */

/** What a line's product must carry for either direction: its own names, and its family's name. */
export const LINE_NAME_PRODUCT_SELECT = {
  name: true,
  variantName: true,
  parentProductId: true,
  parent: { select: { name: true } },
} as const;

/** The order-line product read `buildInvoiceItemData` needs: the pack and category facts it always read, plus the names. */
export const ORDER_LINE_PRODUCT_SELECT = {
  ...LINE_NAME_PRODUCT_SELECT,
  unitsPerBox: true,
  trackedCategoryId: true,
  trackedSubcategoryId: true,
} as const;

export interface LineNameProduct extends DisplayNameProduct {
  parent?: { name: string } | null;
}

/** A product row as a loader typed it: every name optional (a partial select). */
export interface LooseLineProduct {
  name?: string | null;
  variantName?: string | null;
  parentProductId?: string | null;
  parent?: { name: string } | null;
}

/** The name a NEW line stores for a catalogue product. A standalone product is its own name. */
export function lineProductName(product: LineNameProduct): string {
  return productDisplayName(product, product.parent?.name);
}

const same = (a: string, b: string | null | undefined) =>
  b != null && a.trim().toLowerCase() === b.trim().toLowerCase();

/** An existing line's description as it reads: composed when it is still the bare name, else exactly as stored. */
export function displayLineDescription<D extends string | null | undefined>(
  description: D,
  product: LooseLineProduct | null | undefined,
): D {
  if (!description || !product?.parentProductId) return description;
  if (!same(description, product.name) && !same(description, product.variantName))
    return description;
  return lineProductName({ ...product, name: product.name ?? "" }) as D;
}

interface NamedLine {
  description: string;
  product?: LooseLineProduct | null;
}

/** The lines with each description composed (see `displayLineDescription`). A NEW array; the input rows are untouched. */
export function withFamilyNames<T>(items: readonly T[]): T[] {
  return items.map((line) => {
    const { description, product } = line as unknown as NamedLine;
    const composed = displayLineDescription(description, product);
    return composed === description ? line : { ...line, description: composed };
  });
}
