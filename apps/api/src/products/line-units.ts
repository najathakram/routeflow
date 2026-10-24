import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  PIECE_LABEL,
  baseLabelOf,
  describeBaseOption,
  normalizeBoxesPieces,
  planBaseBilling,
  roundMoney,
  defaultSellingLabel,
  UnknownUnitError,
  resolveLadderLevel,
  type LadderProduct,
  type LadderUnit,
} from "@routeflow/pricing";
import { keepsHeldUnit, norm } from "../orders/unit-label-norm";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * THE one place an order/invoice line's pack factor is decided (units_v1, step 4).
 *
 * Every line writer used to read `product.unitsPerBox` straight off the LIVE product — which is
 * only safe while a line's unit can never differ from the pack. With unit levels (Case, Pallet,
 * Piece) a line carries its OWN factor + `unitLabel`, and re-deriving the factor from the live
 * pack would silently re-price a case line at the pack's size (the verified 4× money bug).
 * So the rules are:
 *   1. The SERVER resolves the factor from the product's ladder by label — never from the client.
 *   2. A line that already carries a `unitLabel` keeps ITS snapshot factor on a rewrite; the live
 *      product is not consulted. (If the snapshot is missing it is recovered from the ladder by
 *      label — never guessed from the pack.)
 *   3. No label anywhere ⇒ exactly today's behaviour: `Number(product.unitsPerBox ?? 0)`, and no
 *      `unitLabel` is persisted (NULL = the pack, byte for byte).
 *
 * `requested.unitLabel`: `undefined` = "unchanged" (keep the line's unit); `null`/"" = an explicit
 * "sell by the pack" (clears a unit-aware line); a string = that unit.
 *
 * `line-units-callsites.spec.ts` ratchets the remaining direct `product.unitsPerBox` reads in the
 * line-writing services down to zero.
 */

/** All the helper reads off a product: the pack's label and size. */
export type LineUnitsProduct = Pick<LadderProduct, "unit" | "unitsPerBox">;

export interface LineUnitsExisting {
  unitLabel?: string | null;
  /** The line's own snapshotted factor (OrderItem/InvoiceItem.unitsPerBox). */
  unitsPerBox?: number | null;
}

export interface ResolvedLineUnits {
  /** Pieces per ONE of the line's selling unit — the factor every downstream helper uses. */
  unitsPerBox: number;
  /** Persist on the line. NULL for a plain pack line (today's data, unchanged). */
  unitLabel: string | null;
  kind: "pack" | "piece" | "level";
}

const toFactor = (v: unknown): number => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) && n >= 1 ? n : 0;
};
const kindOf = (label: string, factor: number): "piece" | "level" =>
  norm(label) === norm(PIECE_LABEL) || factor === 1 ? "piece" : "level";

/** The pack as a resolved (label-less) line — byte-identical to every pre-units site. */
const packLine = (product: LineUnitsProduct): ResolvedLineUnits => ({
  unitsPerBox: Number(product.unitsPerBox ?? 0),
  unitLabel: null,
  kind: "pack",
});

export function resolveLineUnits(
  product: LineUnitsProduct,
  units: readonly LadderUnit[],
  requested?: { unitLabel?: string | null; boxes?: number | null; pieces?: number | null } | null,
  existing?: LineUnitsExisting | null,
  /**
   * #2784 / SA-601: a BUYER's plain qty on a NEW line (no unit requested, no existing line) resolves to the level flagged
   * `isDefaultSelling`, else the pack. Off by default — the staff and driver arms stay exactly as SA-593g pinned.
   * An explicit unit (incl. an explicit null/"" = the pack) always wins.
   */
  opts?: { honourDefaultSelling?: boolean },
): ResolvedLineUnits {
  let explicit = requested?.unitLabel; // undefined = unchanged
  // SA-610: only a NEW line (no `existing`) takes the default — a held pack line (existing, unitLabel null) stays a pack.
  // SA-610 B2 / SA-601(2): an explicit boxes/pieces split always wins — only a QTY-ONLY line takes the default.
  const qtyOnly = requested?.boxes == null && requested?.pieces == null;
  if (opts?.honourDefaultSelling && explicit === undefined && existing == null && qtyOnly) {
    const dflt = defaultSellingLabel({ pricePerUnit: 0, ...product }, units);
    if (dflt) explicit = dflt;
  }
  const asked = (explicit ?? "").trim();
  const held = (existing?.unitLabel ?? "").trim();
  const ladderProduct: LadderProduct = { pricePerUnit: 0, ...product };

  // Rule 2: a rewrite that leaves the unit unchanged (or re-sends the same one) keeps the line —
  // THE keep-held-unit rule (SA-070), shared with the restriction netting.
  if (keepsHeldUnit(explicit, held)) {
    let factor = toFactor(existing?.unitsPerBox);
    if (factor === 0) {
      // Snapshot missing/corrupt: recover it from the ladder BY LABEL, never from the pack.
      try {
        const lvl = resolveLadderLevel(ladderProduct, units, held);
        factor = lvl.kind === "pack" ? 0 : lvl.factorToBase;
      } catch {
        factor = 0;
      }
    }
    if (factor === 0) {
      throw new ConflictException(
        `This line is sold by the ${held} but its size is unknown, so it can't be edited safely. Ask an admin to fix the line.`,
      );
    }
    return { unitsPerBox: factor, unitLabel: held, kind: kindOf(held, factor) };
  }

  // Rule 1 / 3: resolve by label against the server ladder (absent/cleared = the pack).
  let level;
  try {
    level = resolveLadderLevel(ladderProduct, units, asked || null);
  } catch (e) {
    if (e instanceof UnknownUnitError) {
      // #2277: the same code as a held unit the product no longer offers (unit-line-build.ts).
      throw new BadRequestException({
        code: API_ERROR_CODES.UNIT_NOT_OFFERED,
        message: `"${e.unitLabel}" is not a unit of this product.`,
      });
    }
    throw e;
  }
  // "Piece" on a product with no pack size is just the product itself — no unit-aware line.
  const packIsBoxed = Number(product.unitsPerBox ?? 0) > 1;
  if (level.kind === "pack" || (level.kind === "piece" && !packIsBoxed)) return packLine(product);
  return { unitsPerBox: level.factorToBase, unitLabel: level.label, kind: level.kind };
}

/**
 * What to store in `line.unitsPerBox`. A unit-aware line ALWAYS snapshots its factor (even 1, for a
 * Piece line on a boxed product — otherwise a later rewrite would re-derive the live pack size).
 * A plain pack line keeps the calling site's EXISTING rule, named so a conversion cannot drift:
 *   - "boxed" (orders, invoices create/update): only a box-split line over a real pack snapshots
 *     (`boxes != null && upb > 1`).
 *   - "positive" (invoice-from-order copy, regroup): any positive factor snapshots (`upb > 0`).
 */
export function lineUnitsPerBoxSnapshot(
  resolved: ResolvedLineUnits,
  boxes: number | null | undefined,
  packRule: "boxed" | "positive" = "boxed",
): number | null {
  if (resolved.unitLabel != null) return resolved.unitsPerBox;
  if (packRule === "positive") return resolved.unitsPerBox > 0 ? resolved.unitsPerBox : null;
  return boxes != null && resolved.unitsPerBox > 1 ? resolved.unitsPerBox : null;
}

// ─── SA-728 / units P0b: a DERIVED base unit bills as the pack line's pieces ──────────────────────

/** A Prisma product row (Decimal prices) as the pricing ladder's product. */
export function asLadderProduct(p: Record<string, any>): LadderProduct {
  const str = (v: string | number | { toString(): string } | null | undefined) =>
    v == null ? null : v.toString();
  return {
    unit: p.unit,
    baseUnitLabel: p.baseUnitLabel,
    packLabel: p.packLabel,
    unitsPerBox: p.unitsPerBox,
    pricePerUnit: (p.pricePerUnit ?? 0).toString(),
    priceTier2: str(p.priceTier2),
    priceTier3: str(p.priceTier3),
    priceTier4: str(p.priceTier4),
    priceTier5: str(p.priceTier5),
  };
}

/**
 * An OLD client (or a stale picker) sends a derived Piece as `{ unitLabel: "Piece", qty: n }` and prices
 * it per piece — which, rounded to the cent, bills `n x $3.33` where the pack's proration says $6.67.
 * The server turns that line into the PACK line's pieces (boxes/pieces via normalizeBoxesPieces, no
 * unitLabel stored) so `computeLineSubtotal` prorates it. Left untouched (returns the SAME object):
 * a base with its OWN price (the unit-line path), a non-base label, an explicit boxes/pieces split,
 * a line already held on the base, an unboxed product, a fractional/zero count, and a typed per-piece
 * price that is NOT the derived price (a deliberate override).
 *
 * `price: "drop"` (orders) removes the echoed per-piece price so the pack branch prices at the tier;
 * `"pack"` (manual invoices, which take the price as typed) replaces it with the PACK's tier price.
 */
export function normalizeDerivedBaseLine<
  T extends {
    unitLabel?: string | null;
    qty?: number | null;
    boxes?: number | null;
    pieces?: number | null;
    unitPrice?: number | null;
  },
>(
  item: T,
  product: LadderProduct | null | undefined,
  units: readonly LadderUnit[],
  tier: number | string,
  opts?: {
    price?: "drop" | "pack";
    held?: string | null;
    /** `price: "pack"` only: the pack price to stamp when it is NOT the tier's (S19: the customer layer's). */
    packPrice?: number | null;
  },
): T {
  const label = (item.unitLabel ?? "").trim();
  if (!label || !product) return item;
  const isBase = (l: string) =>
    norm(l) === norm(baseLabelOf(product)) || norm(l) === norm(PIECE_LABEL);
  if (!isBase(label) || ((opts?.held ?? "").trim() !== "" && isBase(opts!.held!))) return item;
  if (Math.trunc(Number(product.unitsPerBox ?? 0)) <= 1) return item;
  if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) return item;
  const count = Number(item.qty);
  if (!Number.isInteger(count) || count <= 0) return item;
  const billing = planBaseBilling(product, units, tier, count);
  if (billing.mode !== "pack") return item;
  if (item.unitPrice != null) {
    if (roundMoney(Number(item.unitPrice)) !== describeBaseOption(product, units, tier).price) {
      return item;
    }
  }
  const split = normalizeBoxesPieces({
    boxes: 0,
    pieces: count,
    unitsPerBox: Number(product.unitsPerBox),
  });
  const out = {
    ...item,
    unitLabel: null,
    qty: split.qty,
    boxes: split.boxes,
    pieces: split.pieces,
  } as T;
  if (opts?.price === "pack")
    (out as { unitPrice?: number | null }).unitPrice = opts.packPrice ?? billing.packUnitPrice;
  else delete (out as { unitPrice?: number | null }).unitPrice;
  return out;
}
