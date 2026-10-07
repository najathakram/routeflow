/**
 * Which product `ProductPickerSheet` hands to `onSelect` once a row, a scan hit or a confirmed
 * suggestion has been chosen. A parent-only picker (`standaloneOnly`) resolves a variant to its
 * parent; every other pick is the product itself. ONE function so no path can skip the rule.
 */
export async function resolvePickedProduct<T extends { parentProductId?: string | null }>(
  product: T,
  opts: {
    standaloneOnly: boolean;
    fetchParent: (parentId: string) => Promise<T | null | undefined>;
  },
): Promise<{ product: T; resolvedToParent: boolean } | null> {
  if (opts.standaloneOnly && product.parentProductId) {
    const parent = await opts.fetchParent(product.parentProductId);
    return parent ? { product: parent, resolvedToParent: true } : null;
  }
  return { product, resolvedToParent: false };
}
