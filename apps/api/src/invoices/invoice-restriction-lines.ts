/**
 * F-05 (#2093): which catalog lines an invoice edit or copy asks the selling-restrictions choke point
 * about. An edit is netted PER PRODUCT like the order edit path: `qtyDelta = requested - held`, so a note
 * or a decrease on a DRAFT that holds a since-banned product is never refused for the line it already had,
 * an INCREASE is (5 -> 50 asks for 45), and a product the invoice did not hold has NO delta, which the
 * choke point reads as "cannot be netted, check it". Quantities are pieces: an invoice edit refuses
 * unit-labelled lines (`requestsUnit`), so `qty` is already the base-unit count. A copy is a brand-new
 * document, so every catalog line counts.
 */
export function netEditRestrictionLines(
  held: ReadonlyArray<{ productId: string | null; qty: unknown }>,
  items: ReadonlyArray<{ productId?: string | null; qty?: unknown }>,
): { productId: string; qtyDelta?: number }[] {
  const sum = (rows: ReadonlyArray<{ productId?: string | null; qty?: unknown }>) => {
    const m = new Map<string, number>();
    for (const r of rows)
      if (r.productId) m.set(r.productId, (m.get(r.productId) ?? 0) + Number(r.qty));
    return m;
  };
  const had = sum(held);
  const out: { productId: string; qtyDelta?: number }[] = [];
  for (const [productId, want] of sum(items)) {
    if (!had.has(productId))
      out.push({ productId }); // not held: no delta, always checked
    else if (!(want - had.get(productId)! <= 0))
      out.push({ productId, qtyDelta: want - had.get(productId)! });
  }
  return out;
}

export function catalogRestrictionLines(
  items: ReadonlyArray<{ productId?: string | null }>,
): { productId: string }[] {
  return [...new Set(items.flatMap((it) => (it.productId ? [it.productId] : [])))].map(
    (productId) => ({ productId }),
  );
}

/** `update` with an item replace: the netted lines for what the edit ADDS to what the invoice holds. */
export async function addedRestrictionLines(
  db: {
    invoiceItem: {
      findMany(args: any): Promise<{ productId: string | null; qty: unknown }[]>;
    };
  },
  invoiceId: string,
  items: ReadonlyArray<{ productId?: string | null; qty?: unknown }>,
): Promise<{ productId: string; qtyDelta?: number }[]> {
  const held = await db.invoiceItem.findMany({
    where: { invoiceId },
    select: { productId: true, qty: true },
  });
  return netEditRestrictionLines(held, items);
}
