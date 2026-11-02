import {
  normalizeBoxesPieces,
  plural,
  sumPiecesByProduct,
  toPieces,
  unitWords,
} from "@routeflow/pricing";
import type { StockAvailability } from "@routeflow/types";

/**
 * SA-1086: live stock on each order line. A read and a note: the server still decides at save.
 *
 * It only PRESENTS two server numbers (`GET /orders/stock-availability`): `availablePieces` =
 * `Product.currentStock` in pieces and `allowOversell` = the save path's own `resolveOversellAllowed`.
 * Everything else is the save's own arithmetic, imported from `@routeflow/pricing`: each line to pieces
 * with `toPieces`, then summed PER PRODUCT with `sumPiecesByProduct` (B920) — two lines of one product are
 * judged together, never each alone. Edit counts only the increase over the saved lines (what
 * `settleStockForEdit` compares). Never a second copy of that math here.
 *
 * Nothing honest to show, show nothing: a failed read, an unlisted line, a product the server did not
 * return (a recipe, or one the tenant cannot see). Never a fake 0. Negative stock reads as 0 left.
 * There is no blocking flag on purpose: the note never stops Save (a read can be seconds old).
 */
export interface StockLine {
  /** The caller's own row key (the modal's `tempId`, the edit builder's line id). */
  key: string;
  productId: string;
  isUnlisted?: boolean;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  /** A named selling unit ("Case"); empty = the pack. `qty` is then a COUNT of that unit. */
  unitLabel?: string | null;
  /**
   * Pieces in one of that named unit. The save stores `count x factor`, so a named-unit line with no known
   * factor has no honest piece count and shows nothing.
   */
  unitFactor?: number | null;
  /** The product's pack word, for a plain line's "left" count. */
  unit?: string;
  packLabel?: string | null;
  baseLabel?: string | null;
}

export type LineStockView =
  | { state: "loading" }
  | {
      state: "ready";
      /** ok = enough, low = this order asks for more than is there, out = nothing left. */
      level: "ok" | "low" | "out";
      /** "1 box and 8 pieces left", in the line's own unit words. */
      label: string;
      /** The note shown only when the order goes past stock; null otherwise. */
      message: string | null;
      /** Pieces this order takes from the product (edit: only the increase over the saved lines). */
      requestedPieces: number;
    };

/**
 * The words, in one place for the wording pass. "Backorder" agrees with the backorder tag the same
 * line carries once it is saved (`BACKORDER_TAG_LABEL`, W-667).
 */
export const LINE_STOCK_WORDS = {
  loading: "Checking stock…",
  none: "None left",
  over: (label: string) => `Only ${label}`,
  overAllowed: (head: string) => `${head}. The extra goes on backorder.`,
  overRefused: (head: string) => `${head}. Lower the quantity or this order won't save.`,
} as const;

const isNamedUnit = (line: Pick<StockLine, "unitLabel">) => (line.unitLabel ?? "").trim() !== "";

/**
 * One line in pieces, the way the save counts it (the line's own pack first, the product's pack as the fallback).
 * A named-unit line holds a COUNT, so it is count x the unit's factor (the save's `qty = count x factor`);
 * with no known factor the answer is NaN, which poisons its product's total so nothing is shown for it.
 */
export function stockPiecesOf(
  line: Pick<StockLine, "qty" | "boxes" | "pieces" | "unitsPerBox" | "unitLabel" | "unitFactor">,
) {
  let qty = line.qty;
  if (isNamedUnit(line)) {
    const factor = Number(line.unitFactor);
    if (!Number.isFinite(factor) || factor <= 0) return Number.NaN;
    qty = line.qty * factor;
  }
  return toPieces(
    {
      boxes: line.boxes,
      pieces: line.pieces,
      unitsPerBox: line.unitsPerBox,
      unitLabel: line.unitLabel,
    },
    qty,
    line.unitsPerBox,
  );
}

/** What is on hand, in the line's own unit words ("1 box and 8 pieces left"). */
export function stockLeftLabel(line: StockLine, onHand: number): string {
  const label = (line.unitLabel ?? "").trim();
  const words = unitWords({
    packLabel: line.packLabel ?? line.unit,
    baseUnitLabel: line.baseLabel,
  });
  if (label) {
    // `onHand` is in pieces: "20 pieces" of a Case of 12 is "1 case and 8 pieces", the line's own words.
    const factor = Number(line.unitFactor ?? 0);
    const word = label.toLowerCase();
    if (!(factor > 1)) return `${onHand} ${plural(word, onHand)} left`;
    const whole = Math.floor(onHand / factor);
    const loose = Math.round((onHand - whole * factor) * 1000) / 1000;
    if (whole > 0 && loose > 0) {
      return `${whole} ${plural(word, whole)} and ${loose} ${words.baseFor(loose)} left`;
    }
    if (whole > 0) return `${whole} ${plural(word, whole)} left`;
    return `${loose} ${words.baseFor(loose)} left`;
  }
  const pack = Number(line.unitsPerBox ?? 0);
  if (pack > 1) {
    const split = normalizeBoxesPieces({ qty: Math.floor(onHand), unitsPerBox: pack });
    const boxes = split.boxes ?? 0;
    const loose = split.pieces ?? 0;
    if (boxes > 0 && loose > 0) {
      return `${boxes} ${words.packFor(boxes)} and ${loose} ${words.baseFor(loose)} left`;
    }
    if (boxes > 0) return `${boxes} ${words.packFor(boxes)} left`;
    return `${loose} ${words.baseFor(loose)} left`;
  }
  return line.unit
    ? `${onHand} ${plural(line.unit.toLowerCase(), onHand)} left`
    : `${onHand} ${words.baseFor(onHand)} left`;
}

export function lineStockViews(args: {
  lines: StockLine[];
  availability: StockAvailability | undefined;
  /** The read failed (and left no data to show). */
  failed: boolean;
  /** A read is in flight. */
  fetching: boolean;
  /** Edit: the pieces each product already holds on the saved order. Omitted on New Order. */
  savedPiecesByProduct?: ReadonlyMap<string, number>;
}): Map<string, LineStockView> {
  const out = new Map<string, LineStockView>();
  const { availability } = args;
  const listed = args.lines.filter((l) => !l.isUnlisted && l.productId);
  if (listed.length === 0) return out;
  if (!availability) {
    if (!args.failed && args.fetching) {
      for (const l of listed) out.set(l.key, { state: "loading" });
    }
    return out;
  }
  const onHandOf = new Map(availability.items.map((i) => [i.productId, i.availablePieces]));
  const totals = sumPiecesByProduct(
    listed.map((l) => ({ productId: l.productId, pieces: stockPiecesOf(l) })),
  );
  for (const line of listed) {
    const available = onHandOf.get(line.productId);
    if (available === undefined || !Number.isFinite(available)) continue;
    const onHand = Math.max(0, available);
    const total = totals.get(line.productId) ?? 0;
    const saved = args.savedPiecesByProduct?.get(line.productId) ?? 0;
    // A line with no honest piece count (a named unit of unknown size), here or on the saved order: show nothing.
    if (!Number.isFinite(total) || !Number.isFinite(saved)) continue;
    const requested = args.savedPiecesByProduct ? Math.max(0, total - saved) : total;
    const over = requested > onHand;
    const label = stockLeftLabel(line, onHand);
    const level = onHand <= 0 ? "out" : over ? "low" : "ok";
    const head = onHand <= 0 ? LINE_STOCK_WORDS.none : LINE_STOCK_WORDS.over(label);
    const message = !over
      ? null
      : availability.allowOversell
        ? LINE_STOCK_WORDS.overAllowed(head)
        : LINE_STOCK_WORDS.overRefused(head);
    out.set(line.key, { state: "ready", level, label, message, requestedPieces: requested });
  }
  return out;
}
