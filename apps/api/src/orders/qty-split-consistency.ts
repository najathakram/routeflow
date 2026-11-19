import { BadRequestException, Logger } from "@nestjs/common";
import { packFromOwnSplit } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Row 531 (F2, SA ruling 2026-10-14): the ONE check for an order line that names BOTH a `qty` and a
 * `boxes`/`pieces` split for a boxed product (`unitsPerBox > 1`) and the two disagree.
 *
 * The write paths prefer the split (`normalizeBoxesPieces` reads boxes x pack + pieces and ignores
 * `qty`), so a contradictory pair is stored at the split's quantity with no error: a buyer cart that
 * shows "2 each" is billed one box. Two modes, one rule:
 *
 *  - `enforce` (the BUYER paths: create, the fold into an active order, edit lines): a coded 400
 *    QTY_SPLIT_MISMATCH, thrown from the payload alone BEFORE any read-for-write, lock or write, so
 *    nothing is saved. The buyer client shows one fixed sentence.
 *  - `warn` (the staff / shared paths, and counter sale): a Logger.warn naming the path, tenant and
 *    product; the write proceeds EXACTLY as before. Enforcement there waits for its own ruling, and
 *    these logs are the evidence for it.
 *
 * "Split sent" is the predicate the create path already uses to decide whether the split is read
 * (`boxes > 0 || pieces > 0`): a zero / absent split is "not using box entry" and never mismatches.
 * "Qty sent" is a finite `qty`. A product that is not boxed has no split to disagree with.
 */

export type QtySplitMode = "enforce" | "warn";

export interface QtySplitLine {
  productId?: string | null;
  /** The stored order line an edit entry names (buyer edit-lines); the buyer check reads THAT line's own pack. */
  orderItemId?: string | null;
  qty?: number | string | null;
  boxes?: number | null;
  pieces?: number | null;
}

export interface QtySplitMismatch {
  productId: string | null;
  qty: number;
  boxes: number;
  pieces: number;
  unitsPerBox: number;
}

/** The mismatch on one line, or null when it is consistent / not checkable. Pure. */
export function qtySplitMismatch(
  line: QtySplitLine,
  unitsPerBox: number | null | undefined,
): QtySplitMismatch | null {
  const upb = Math.trunc(Number(unitsPerBox ?? 0));
  if (!(upb > 1)) return null;
  const boxes = Math.trunc(Number(line.boxes ?? 0));
  const pieces = Math.trunc(Number(line.pieces ?? 0));
  if (!(boxes > 0 || pieces > 0)) return null;
  if (line.qty == null || line.qty === "") return null;
  const qty = Number(line.qty);
  if (!Number.isFinite(qty)) return null;
  if (boxes * upb + pieces === qty) return null;
  return { productId: line.productId ?? null, qty, boxes, pieces, unitsPerBox: upb };
}

/**
 * SA-1170 K1 (B729): a split sent for a product with NO pack (live pack <= 1) must still agree with its own
 * qty. Self-consistent when it carries boxes whose own pack is whole (`packFromOwnSplit`, the stale-cart shape
 * that folds correctly), or pieces only and equal to qty; a zero / absent split is no split. Anything else is
 * contradictory (a fold would bill it at the stored pack). Pure; enforce mode only (see checkQtySplitConsistency).
 */
export function unpackableSplitMismatch(
  line: QtySplitLine,
  unitsPerBox: number | null | undefined,
): QtySplitMismatch | null {
  const upb = Math.trunc(Number(unitsPerBox ?? 0));
  if (upb > 1) return null;
  const boxes = Math.trunc(Number(line.boxes ?? 0));
  const pieces = Math.trunc(Number(line.pieces ?? 0));
  if (!(boxes > 0 || pieces > 0)) return null;
  if (line.qty == null || line.qty === "") return null;
  const qty = Number(line.qty);
  if (!Number.isFinite(qty)) return null;
  if (boxes > 0 && packFromOwnSplit({ qty, boxes, pieces }) != null) return null;
  if (!(boxes > 0) && pieces === qty) return null;
  return { productId: line.productId ?? null, qty, boxes, pieces, unitsPerBox: upb };
}

export interface CheckQtySplitArgs {
  mode: QtySplitMode;
  /** Which writer this is, e.g. "buyer.createOrder" or "orders.create". Appears in the warn log. */
  path: string;
  items: readonly QtySplitLine[];
  /** The pack size of the product a line names (the caller's own lookup; null / 0 / 1 = not boxed). */
  upbFor: (line: QtySplitLine) => number | null | undefined;
  tenantId?: string | null;
  logger?: Logger;
}

const fallbackLogger = new Logger("QtySplitConsistency");

/**
 * Check every line. `enforce` throws the coded 400 on the first batch of mismatches (naming all the
 * productIds); `warn` logs each and returns them. Returns the mismatches found either way.
 */
export function checkQtySplitConsistency(args: CheckQtySplitArgs): QtySplitMismatch[] {
  const found: QtySplitMismatch[] = [];
  for (const line of args.items) {
    const upb = args.upbFor(line);
    // enforce only, and only when the caller KNOWS the product (undefined = not found: the writer refuses it).
    const m =
      qtySplitMismatch(line, upb) ??
      (args.mode === "enforce" && upb != null ? unpackableSplitMismatch(line, upb) : null);
    if (m) found.push(m);
  }
  if (found.length === 0) return found;
  if (args.mode === "enforce") {
    throw new BadRequestException({
      code: API_ERROR_CODES.QTY_SPLIT_MISMATCH,
      message: "The quantity and the box split of a line disagree. Review the cart and try again.",
      productIds: found.map((m) => m.productId).filter((id): id is string => !!id),
    });
  }
  const logger = args.logger ?? fallbackLogger;
  for (const m of found) {
    logger.warn(
      `qty/split mismatch (warn only) path=${args.path} tenantId=${args.tenantId ?? "none"} ` +
        `productId=${m.productId ?? "none"} qty=${m.qty} boxes=${m.boxes} pieces=${m.pieces} ` +
        `unitsPerBox=${m.unitsPerBox}`,
    );
  }
  return found;
}

/**
 * Warn-mode convenience for ONE line whose pack size the caller already holds. It can never throw
 * and never changes the caller's behaviour: a staff write must not fail because a log line did.
 */
export function warnQtySplit(
  logger: Logger | undefined,
  tenantId: string | null | undefined,
  path: string,
  line: QtySplitLine,
  unitsPerBox: number | null | undefined,
): void {
  try {
    checkQtySplitConsistency({
      mode: "warn",
      path,
      items: [line],
      upbFor: () => unitsPerBox,
      tenantId,
      logger,
    });
  } catch {
    // warn mode is advisory only
  }
}
