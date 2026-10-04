import { normalizeBoxesPieces } from "@routeflow/pricing";

/**
 * Live stock for ONE order line. It only PRESENTS two server numbers (`GET /orders/stock-availability`):
 * `availablePieces` = Product.currentStock in pieces and `allowOversell` = the save path's own
 * `resolveOversellAllowed`. The comparison mirrors the server: create compares the line's pieces to
 * the stock (`decrementStockForSale`), edit compares only the INCREASE over the saved line
 * (`settleStockForEdit`'s delta). Pieces <-> cases goes through `normalizeBoxesPieces`.
 */
export interface LineStockLine {
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
}

export type LineStockView =
  | { state: "loading" }
  | {
      state: "ready";
      /** ok = enough, low = the line asks for more than is there (amber), out = nothing left (red). */
      level: "ok" | "low" | "out";
      /** "12 cases left" - in the line's own unit. */
      label: string;
      /** Fixed-copy note shown only when the line exceeds stock; null otherwise. */
      message: string | null;
      /** True only when the server would refuse this line (oversell not allowed AND over stock). */
      blocksSubmit: boolean;
    };

const caseWord = (n: number) => (n === 1 ? "case" : "cases");
const unitWord = (n: number) => (n === 1 ? "unit" : "units");

export function lineStockView(args: {
  line: LineStockLine;
  /** Product.currentStock in pieces; undefined while loading or unknown. */
  availablePieces: number | undefined;
  /** Server's oversell verdict; undefined while loading. */
  allowOversell: boolean | undefined;
  /** Case|Unit toggle on a boxed line: true counts the shelf in units, not cases. */
  sellByUnit?: boolean;
  /** Plain line's unit word ("bag"). */
  unit?: string;
  /** Edit mode: the pieces this line already holds on the saved order. */
  savedPieces?: number;
}): LineStockView {
  const { line, availablePieces, allowOversell } = args;
  if (
    availablePieces === undefined ||
    !Number.isFinite(availablePieces) ||
    allowOversell === undefined
  ) {
    return { state: "loading" };
  }
  const boxed = Number(line.unitsPerBox ?? 0) > 1 && !line.unitLabel;
  const requested = boxed
    ? normalizeBoxesPieces({
        boxes: line.boxes,
        pieces: line.pieces,
        qty: line.qty,
        unitsPerBox: line.unitsPerBox,
      }).qty
    : Math.max(0, Number(line.qty) || 0);
  const delta =
    args.savedPieces === undefined ? requested : Math.max(0, requested - args.savedPieces);
  const onHand = Math.max(0, availablePieces);
  const over = delta > onHand;

  let label: string;
  if (boxed && !args.sellByUnit) {
    const split = normalizeBoxesPieces({ qty: Math.floor(onHand), unitsPerBox: line.unitsPerBox });
    const cases = split.boxes ?? 0;
    const loose = split.pieces ?? 0;
    label =
      cases > 0 && loose > 0
        ? `${cases} ${caseWord(cases)} + ${loose} ${unitWord(loose)} left`
        : cases > 0
          ? `${cases} ${caseWord(cases)} left`
          : `${loose} ${unitWord(loose)} left`;
    if (cases === 0 && loose === 0) label = "0 left";
  } else if (boxed) {
    label = `${onHand} ${unitWord(onHand)} left`;
  } else {
    label = args.unit ? `${onHand} ${args.unit} left` : `${onHand} left`;
  }

  const level = onHand <= 0 ? "out" : over ? "low" : "ok";
  const head = onHand <= 0 ? "None left" : `Only ${label}`;
  const message = !over
    ? null
    : allowOversell
      ? `${head} — this order will go below stock`
      : `${head} — reduce or remove`;
  return { state: "ready", level, label, message, blocksSubmit: over && !allowOversell };
}
