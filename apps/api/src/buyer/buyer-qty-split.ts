import { checkQtySplitConsistency, type QtySplitLine } from "../orders/qty-split-consistency";

/** The reads this file makes: the pack size of the products a payload names, and (edits) of the lines it names. */
interface PackReader {
  product: {
    findMany(args: {
      where: { id: { in: string[] } };
      select: { id: true; unitsPerBox: true };
    }): Promise<Array<{ id: string; unitsPerBox: number | null }>>;
  };
  orderItem?: {
    findMany(args: {
      where: { id: { in: string[] }; orderId: string; order: { customerId: string } };
      select: { id: true; unitsPerBox: true };
    }): Promise<Array<{ id: string; unitsPerBox: number | null }>>;
  };
}

/** The order an edit targets; scopes the stored-line lookup to the buyer's OWN order. */
export interface BuyerEditScope {
  orderId: string;
  customerId: string;
}

/**
 * Row 531 F2 (ENFORCE) for the BUYER order writers: a boxed line that names a qty AND a box split which
 * disagree is a coded 400 QTY_SPLIT_MISMATCH, from the payload alone, before any lock, read-for-write or write.
 * The controller calls it first in createOrder (the create branch AND the fold into an active order) and in the
 * edit-lines route.
 *
 * It reads ONE column, `unitsPerBox`, of the products (and, for an edit, the stored lines) the buyer's OWN payload
 * names, only to compare it with that payload's qty / split; the pack size is never returned (the 400 echoes only
 * the ids the buyer sent). A product the lookup does not return has no pack size here and passes: the writer's own
 * product checks refuse it.
 */
export async function assertBuyerQtySplit(
  db: PackReader,
  items: ReadonlyArray<QtySplitLine> | undefined,
  path: string,
  tenantId?: string | null,
  edit?: BuyerEditScope,
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
  const livePack = new Map(products.map((p) => [p.id, Number(p.unitsPerBox ?? 0)]));
  // An EDIT entry that names a stored line is read in THAT line's own sale-time pack (what the buyer sees and
  // echoes back), falling back to the live pack when no line is named, the line is not found on this buyer's own
  // order, or it carries no snapshot. The lookup is scoped to this order and this customer: another buyer's line
  // is never read, so its pack size cannot be probed through the 400.
  const linePack = new Map<string, number>();
  const lineIds = [
    ...new Set(splitLines.map((i) => i.orderItemId).filter((v): v is string => !!v)),
  ];
  if (edit && lineIds.length > 0 && db.orderItem) {
    const rows = await db.orderItem.findMany({
      where: { id: { in: lineIds }, orderId: edit.orderId, order: { customerId: edit.customerId } },
      select: { id: true, unitsPerBox: true },
    });
    for (const r of rows)
      if (Number(r.unitsPerBox ?? 0) > 1) linePack.set(r.id, Number(r.unitsPerBox));
  }
  checkQtySplitConsistency({
    mode: "enforce",
    path,
    items: splitLines,
    upbFor: (l) =>
      (l.orderItemId ? linePack.get(l.orderItemId) : undefined) ??
      livePack.get(l.productId as string),
    tenantId,
  });
}
