import { checkQtySplitConsistency, type QtySplitLine } from "../orders/qty-split-consistency";

/** The one read this file makes: the pack size of the products a payload names (tenant-scoped client). */
interface PackReader {
  product: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; unitsPerBox: true };
    }): Promise<Array<{ id: string; unitsPerBox: number | null }>>;
  };
}

/**
 * Row 531 F2 (ENFORCE) for the BUYER order writers: a boxed line that names a qty AND a box split which
 * disagree is a coded 400 QTY_SPLIT_MISMATCH, from the payload alone, before any lock, read-for-write or write.
 * The controller calls it first in createOrder (the create branch AND the fold into an active order) and in the
 * edit-lines route.
 *
 * It reads ONE column, `unitsPerBox`, of the products the buyer's OWN payload names, only to compare it with that
 * payload's qty / split; the pack size is never returned (the 400 echoes only the ids the buyer sent). A product
 * the lookup does not return has no pack size here and passes: the writer's own product checks refuse it.
 */
export async function assertBuyerQtySplit(
  db: PackReader,
  items: ReadonlyArray<QtySplitLine> | undefined,
  path: string,
  tenantId?: string | null,
): Promise<void> {
  const splitLines = (items ?? []).filter(
    (i) => i.productId && (i.boxes != null || i.pieces != null),
  );
  if (splitLines.length === 0) return;
  const ids = [...new Set(splitLines.map((i) => i.productId as string))];
  const products = await db.product.findMany({
    where: { id: { in: ids } },
    select: { id: true, unitsPerBox: true },
  });
  const pack = new Map(products.map((p) => [p.id, Number(p.unitsPerBox ?? 0)]));
  checkQtySplitConsistency({
    mode: "enforce",
    path,
    items: splitLines,
    upbFor: (l) => pack.get(l.productId as string),
    tenantId,
  });
}
