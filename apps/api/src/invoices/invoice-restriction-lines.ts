import { ConflictException } from "@nestjs/common";
import {
  regulatedUnitBasis,
  resolveLadderLevel,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import { keepsHeldUnit, norm } from "../orders/unit-label-norm";
import { OVERRIDE_STAMP_SELECT, type OverrideStamp } from "../common/restriction-override-columns";
import { checkableProductIds } from "../selling-restrictions/selling-restrictions.core";
import { API_ERROR_CODES } from "../common/api-error-codes";

type EditRow = {
  id?: string | null;
  productId?: string | null;
  qty?: unknown;
  boxes?: unknown;
  pieces?: unknown;
  unitsPerBox?: unknown;
  unitLabel?: string | null;
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
 * of the two (never under-asks).
 *
 * VU-4a (M1): unit lines. A HELD unit row is stored like a split whose box is the unit (boxes = count,
 * qty = count x factor pieces, unitsPerBox = factor), so it already counts its pieces above. An INCOMING
 * unit line sends a COUNT of the unit and counts count x factor: the held row's snapshot factor when it keeps
 * that row's unit (SA-070: absent or the same label), else the factor the IN-LOCK ladder resolves for the
 * label (`ladders`, read through the same reader as the held rows). A label nothing can size is FAIL-CLOSED:
 * the product is emitted with no delta, so it is always judged. A held unit row LEFT for the pack with a bare
 * count counts boxes at the live pack, as the write does; a factor-1 (Piece) row left that way counts pieces.
 *
 * SA-250: an incoming line with NO split that names (by id) a held row of the same product WITH a split is
 * counted as `qty` pieces — #2083's edit plan re-splits exactly that payload at the row's own pack (SA-219),
 * so it bills qty pieces, not qty boxes. A held row without a split keeps the legacy qty x pack reading.
 */
export type LivePacks = ReadonlyMap<string, number | null>;
/** productId -> the product's pack fields and its unit ladder, for sizing a unit label. */
export type Ladders = ReadonlyMap<string, { product: LadderProduct; units: readonly LadderUnit[] }>;

const hasLabel = (l: string | null | undefined) => norm(l ?? "") !== "";

/** The pieces in one of `label` for `productId` from the ladder, or null when nothing can size it. */
function ladderFactor(
  ladders: Ladders | undefined,
  productId: string,
  label: string,
): number | null {
  const l = ladders?.get(productId);
  if (!l) return null;
  try {
    const f = resolveLadderLevel(l.product, l.units, label).factorToBase;
    return f >= 1 ? f : null;
  } catch {
    return null; // UnknownUnitError: a label the ladder does not sell
  }
}
const snapFactor = (row: EditRow): number | null => {
  const f = Math.trunc(Number(row.unitsPerBox ?? 0));
  return f >= 1 ? f : null;
};

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
  ladders?: Ladders,
): { productId: string; qtyDelta?: number }[] {
  const unsized = new Set<string>();
  /** VU-4a: an incoming line's pieces when a unit is in play; undefined = not a unit case. */
  const unitPieces = (r: EditRow & { productId: string }, own: EditRow | undefined) => {
    if (r.boxes != null || r.pieces != null) return undefined; // the write refuses a split on a unit line
    const heldUnit = own && hasLabel(own.unitLabel) ? own : undefined;
    if (heldUnit && keepsHeldUnit(r.unitLabel, heldUnit.unitLabel)) {
      const f = snapFactor(heldUnit) ?? ladderFactor(ladders, r.productId, heldUnit.unitLabel!);
      return f == null ? null : Number(r.qty) * f;
    }
    if (hasLabel(r.unitLabel)) {
      const f = ladderFactor(ladders, r.productId, r.unitLabel!);
      return f == null ? null : Number(r.qty) * f;
    }
    if (heldUnit) {
      // Left for the pack with a bare count (invoice-edit-plan's leftUnit re-split): boxes at the LIVE pack,
      // except a factor-1 (Piece) row, whose count stays pieces.
      const livePack = Number(live.get(r.productId) ?? 0);
      return (snapFactor(heldUnit) ?? 0) > 1 && livePack > 1
        ? Number(r.qty) * livePack
        : Number(r.qty);
    }
    return undefined;
  };
  const total = (rows: ReadonlyArray<EditRow>, isHeld: boolean) => {
    const m = new Map<string, number>();
    for (const r of rows) {
      if (!r.productId) continue;
      // SA-377: an id-matched same-product line counts at its held row's pack (re-send nets 0).
      const own = isHeld ? r : heldMatch(r);
      const unit = isHeld ? undefined : unitPieces(r as EditRow & { productId: string }, own);
      if (unit === null) {
        unsized.add(r.productId); // fail closed: judged with no delta
        continue;
      }
      const pack = (own ? num(own.unitsPerBox) : null) ?? live.get(r.productId) ?? null;
      const count =
        unit !== undefined
          ? unit
          : !isHeld && pieceReSplit(r)
            ? Number(r.qty)
            : pieceCount(r, pack);
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
  const want = total(items, false);
  for (const productId of unsized) if (!want.has(productId)) out.push({ productId });
  for (const [productId, wanted] of want) {
    if (unsized.has(productId) || !had.has(productId))
      out.push({ productId }); // not held: no delta, always checked
    else if (!(wanted - had.get(productId)! <= 0))
      out.push({ productId, qtyDelta: wanted - had.get(productId)! });
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
  unitLabel: true,
  ...OVERRIDE_STAMP_SELECT, // row 510: the coverage test reads the held lines' stamps
};
type Reader = {
  invoiceItem: { findMany(args: any): Promise<EditRow[]> };
  product: {
    findMany(args: any): Promise<{ id: string; unitsPerBox: unknown; unit?: string | null }[]>;
  };
  productUnit?: { findMany(args: any): Promise<(LadderUnit & { productId: string })[]> };
};

/** `update` with an item replace: the netted lines for what the edit ADDS to what the invoice holds. */
export async function addedRestrictionLines(
  db: Reader,
  invoiceId: string,
  items: ReadonlyArray<EditRow>,
): Promise<{ productId: string; qtyDelta?: number }[]> {
  return (await addedRestrictionLinesWithHeld(db, invoiceId, items)).lines;
}

/** `addedRestrictionLines` plus the held rows it read (with their override stamps), for the coverage test (row 510). */
export async function addedRestrictionLinesWithHeld(
  db: Reader,
  invoiceId: string,
  items: ReadonlyArray<EditRow>,
): Promise<{
  lines: { productId: string; qtyDelta?: number }[];
  held: Array<EditRow & Partial<OverrideStamp>>;
}> {
  const held = await db.invoiceItem.findMany({ where: { invoiceId }, select: HELD_SELECT });
  const ids = [...new Set([...held, ...items].flatMap((r) => (r.productId ? [r.productId] : [])))];
  const products = ids.length
    ? await db.product.findMany({
        where: { id: { in: ids } },
        select: { id: true, unitsPerBox: true, unit: true },
      })
    : [];
  // VU-4a: the ladder, read through THIS reader (in the edit's tx after the lock), only for products a unit
  // line is in play on. No reader for it (a legacy caller) leaves those lines unsized: judged, never guessed.
  const livePacks = new Map(products.map((p) => [p.id, num(p.unitsPerBox)]));
  const unitIds = [
    ...new Set(
      [...held, ...items].flatMap((r) =>
        r.productId && hasLabel(r.unitLabel) ? [r.productId] : [],
      ),
    ),
  ];
  const rows =
    unitIds.length && db.productUnit
      ? await db.productUnit.findMany({
          where: { productId: { in: unitIds } },
          orderBy: { sortOrder: "asc" },
        })
      : [];
  const ladders = new Map(
    products
      .filter((p) => unitIds.includes(p.id))
      .map((p) => [
        p.id,
        {
          product: {
            unit: p.unit ?? null,
            unitsPerBox: livePacks.get(p.id) ?? null,
            pricePerUnit: 0,
          },
          units: rows.filter((u) => u.productId === p.id),
        },
      ]),
  );
  return { lines: netEditRestrictionLines(held, items, livePacks, ladders), held };
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
