import { ConflictException } from "@nestjs/common";
import { regulatedUnitBasis } from "@routeflow/pricing";
import { checkableProductIds } from "../selling-restrictions/selling-restrictions.core";
import { API_ERROR_CODES } from "../common/api-error-codes";

type EditRow = {
  id?: string | null;
  productId?: string | null;
  qty?: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
};

/**
 * F-05 (#2093): which catalog lines an invoice edit or copy asks the selling-restrictions choke point
 * about. An edit is netted PER PRODUCT in PIECES, like the order edit path: `qtyDelta = requested - held`.
 * A note or a decrease on a DRAFT holding a since-banned product is not refused for the line it already
 * had, an INCREASE is (5 -> 50 asks for 45), and a product the invoice did not hold has NO delta, which
 * the choke point reads as "cannot be netted, check it".
 *
 * Pieces are what the line BILLS: `regulatedUnitBasis` (the one conversion) at the line's own pack — a held
 * line's sale-time snapshot; an incoming line that names (by id) a held row of the SAME product, that row's
 * pack (SA-377); any other incoming line, the product's LIVE pack — so a boxed line with no split counts as
 * qty x pack. A split line bills from boxes/pieces while `qty` is stored as sent, so it counts as the LARGER
 * of the two (never under-asks). Unit-labelled lines are refused on edit, so `unitLabel` is never set here.
 *
 * SA-250: an incoming line with NO split that names (by id) a held row of the same product WITH a split is
 * counted as `qty` pieces — #2083's edit plan re-splits exactly that payload at the row's own pack (SA-219),
 * so it bills qty pieces, not qty boxes. A held row without a split keeps the legacy qty x pack reading.
 */
export type LivePacks = ReadonlyMap<string, number | null>;

const pieceCount = (r: EditRow, pack: number | null | undefined): number => {
  const base = regulatedUnitBasis(
    { qty: Number(r.qty), boxes: num(r.boxes), pieces: num(r.pieces), unitLabel: null },
    pack,
  ).unitBasisQty;
  const split = r.boxes != null || r.pieces != null;
  return split && Number(pack) > 1
    ? Math.max(base, Number(r.boxes ?? 0) * Number(pack) + Number(r.pieces ?? 0))
    : base;
};
const num = (v: unknown) => (v == null ? null : Number(v));

export function netEditRestrictionLines(
  held: ReadonlyArray<EditRow>,
  items: ReadonlyArray<EditRow>,
  live: LivePacks,
): { productId: string; qtyDelta?: number }[] {
  const total = (rows: ReadonlyArray<EditRow>, isHeld: boolean) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.productId) continue;
      // SA-377: an id-matched same-product line counts at its held row's pack (re-send nets 0).
      const own = isHeld ? r : heldMatch(r);
      const pack = (own ? num(own.unitsPerBox) : null) ?? live.get(r.productId) ?? null;
      const count = !isHeld && pieceReSplit(r) ? Number(r.qty) : pieceCount(r, pack);
      m.set(r.productId, (m.get(r.productId) ?? 0) + count);
    }
    return m;
  };
  const heldById = new Map(held.flatMap((r) => (r.id ? [[r.id, r] as const] : [])));
  const heldMatch = (r: EditRow): EditRow | undefined => {
    const row = r.id ? heldById.get(r.id) : undefined;
    return row && (row.productId ?? null) === (r.productId ?? null) ? row : undefined;
  };
  const pieceReSplit = (r: EditRow): boolean => {
    const row = heldMatch(r);
    return (
      !!row && r.boxes == null && r.pieces == null && (row.boxes != null || row.pieces != null)
    );
  };
  const had = total(held, true);
  const out: { productId: string; qtyDelta?: number }[] = [];
  for (const [productId, want] of total(items, false)) {
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

const HELD_SELECT = {
  id: true,
  productId: true,
  qty: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
};
type Reader = {
  invoiceItem: { findMany(args: any): Promise<EditRow[]> };
  product: { findMany(args: any): Promise<{ id: string; unitsPerBox: unknown }[]> };
};

/** `update` with an item replace: the netted lines for what the edit ADDS to what the invoice holds. */
export async function addedRestrictionLines(
  db: Reader,
  invoiceId: string,
  items: ReadonlyArray<EditRow>,
): Promise<{ productId: string; qtyDelta?: number }[]> {
  const held = await db.invoiceItem.findMany({ where: { invoiceId }, select: HELD_SELECT });
  const ids = [...new Set([...held, ...items].flatMap((r) => (r.productId ? [r.productId] : [])))];
  const products = ids.length
    ? await db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  return netEditRestrictionLines(
    held,
    items,
    new Map(products.map((p) => [p.id, num(p.unitsPerBox)])),
  );
}

/**
 * Inside the edit's transaction, AFTER the Invoice row lock: the held lines are read again and the plan is
 * recomputed (a pure recompute). Two concurrent edits each judged against a pre-lock read could otherwise
 * both slip an increase past the check; a product that now needs a check the pre-lock judgment never made
 * refuses with a retryable 409.
 */
export async function assertEditStillJudged(
  tx: Reader & { $executeRaw: any },
  invoiceId: string,
  items: ReadonlyArray<EditRow> | undefined,
  judged: ReadonlyArray<{ productId: string; qtyDelta?: number }>,
): Promise<void> {
  if (!items) return;
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
  const now = checkableProductIds(await addedRestrictionLines(tx, invoiceId, items));
  const seen = new Set(checkableProductIds(judged));
  if (now.some((id) => !seen.has(id)))
    throw new ConflictException({
      code: API_ERROR_CODES.INVOICE_CHANGED_DURING_EDIT,
      message: "The invoice changed while your edit was being applied — review it and try again.",
    });
}
