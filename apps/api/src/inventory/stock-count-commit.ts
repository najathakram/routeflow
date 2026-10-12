/**
 * SA-767 L-2.2 (r-note 2 (b)): the vocabulary of a durable stock count that commits in batches.
 *
 * A warehouse-wide count used to be ONE transaction that locked every counted product for its whole
 * duration (a sale of any counted product waited minutes). It now commits in id-ordered batches of
 * {@link COUNT_COMMIT_BATCH} lines, each its own short transaction; the session stays OPEN / REVIEW
 * (no new enum value, no migration) until a CAS after the last batch flips it to COMMITTED. While some
 * of its movements exist and it is not COMMITTED it is "committing": a second commit, a line edit and
 * a discard are refused with 409 STOCK_COUNT_COMMITTING.
 *
 * The lock protocol (SA-767 L-2.4 B, r-note 4 B): the committer holds the session's `stock-count`
 * advisory lock EXCLUSIVELY across all of its batches; a line edit or a discard holds the SHARED form
 * of the same key pair for its own tx and is 409 STOCK_COUNT_COMMITTING if the committer has it.
 */
import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Lines per commit transaction: bounds how long one count batch holds its Product row locks. */
export const COUNT_COMMIT_BATCH = 50;

/** The advisory-lock family of the committer (exclusive) and of the edits (shared): `db-locks.ts`. */
export const STOCK_COUNT_LOCK_FAMILY = "stock-count" as const;

/** SA-767 r-note 5 SA-3: the tx lock of "add this product to a count", keyed `<tenantId>:<productId>`. */
export const STOCK_COUNT_PRODUCT_LOCK_FAMILY = "stock-count-product" as const;

/** A count in these statuses is "open": it can still be edited and committed. */
export const OPEN_COUNT_STATUSES = ["OPEN", "REVIEW"] as const;

/**
 * The committer's try-lock is retried this many times, `COUNT_LOCK_RETRY_MS` apart, before it answers
 * 409: an edit that is mid-flight holds the SHARED form of the lock for a few milliseconds, and a
 * commit that merely collided with one should wait it out rather than fail (the committer then
 * re-reads the lines, so the finished edit is included). A genuinely second committer holds the
 * exclusive form for minutes and still gets its 409 after ~0.4 s.
 */
export const COUNT_LOCK_ATTEMPTS = 3;
export const COUNT_LOCK_RETRY_MS = 200;

/**
 * Why "Finish with skips" (SA-767 L-2.4 C) left a line out: the product can NEVER be counted by this
 * session. PRODUCT_IS_FAMILY: it is now a product family (a container, never stocked; WS8).
 * PRODUCT_DELETED: it no longer exists. An inactive product is NOT a reason - the committer has always
 * counted those - and a lock timeout or a deadlock is never one (those retry, then 503).
 */
export type StockCountSkipReason = "PRODUCT_IS_FAMILY" | "PRODUCT_DELETED";

export interface StockCountSkippedProduct {
  productId: string;
  name?: string;
  reason: StockCountSkipReason;
}

/** The one line a skip adds to the session's `notes` (single line: notes are newline-separated). */
export function stockCountSkipNote(skip: StockCountSkippedProduct): string {
  const what = (skip.name ?? "").replace(/\s+/g, " ").trim();
  const label = what ? `${what} (${skip.productId})` : skip.productId;
  const why =
    skip.reason === "PRODUCT_IS_FAMILY"
      ? "is now a product family, not counted"
      : "no longer exists, not counted";
  return `Skipped ${label}: ${why}. Recount it in a new session.`;
}

/**
 * How far an unfinished commit got (SA-767 L-2.4 D, r-note 4 D): on the session detail as `commit`
 * while some movement exists and the session is not COMMITTED, and on a 503 LOCK_UNAVAILABLE raised by
 * the committer. `committedLines` = lines whose ADJUSTMENT movement exists; `totalLines` = lines that
 * write one (a zero-delta line never does, so it is in neither number). The client reads "Saving
 * count... N of M" and "Partly saved" / "Nothing was saved" off the same two numbers.
 */
export interface StockCountCommitProgress {
  committedLines: number;
  totalLines: number;
}

type Qty = Prisma.Decimal | number | string;

/** A line writes an ADJUSTMENT iff its delta is non-zero: REPLACE counted - expected, ADD counted. */
export function lineWritesAdjustment(l: {
  mode: string;
  countedQty: Qty;
  expectedQty: Qty;
}): boolean {
  const counted = Number(l.countedQty);
  return l.mode === "ADD" ? counted !== 0 : counted !== Number(l.expectedQty);
}

export function computeCommitProgress(
  lines: ReadonlyArray<{ productId: string; mode: string; countedQty: Qty; expectedQty: Qty }>,
  movements: ReadonlyArray<{ productId: string; type: string }>,
): StockCountCommitProgress {
  const writers = lines.filter(lineWritesAdjustment);
  const adjusted = new Set(
    movements.filter((m) => m.type === "ADJUSTMENT").map((m) => m.productId),
  );
  return {
    committedLines: writers.filter((l) => adjusted.has(l.productId)).length,
    totalLines: writers.length,
  };
}

/** What a committed (or already committed) count answers. */
export interface StockCountCommitOutcome {
  sessionId: string;
  reference: string;
  applied: number;
  skipped: number;
  movementIds: string[];
  costMovementIds?: string[];
  alreadyCommitted?: boolean;
  /** Lines "Finish with skips" left out (always present, empty, on a normal commit). */
  skippedProducts?: StockCountSkippedProduct[];
}

/** The `StockMovement.reference` of every movement a count session writes (also its movementReference). */
export const stockCountReference = (sessionId: string): string => `STOCK_COUNT-${sessionId}`;

/**
 * One product that is already on another OPEN / REVIEW count (SA-767 r-note 5 SA-3). `sessionName` is
 * null for an unnamed count; the client then says "another count".
 */
export interface OpenCountConflict {
  productId: string;
  productName?: string | null;
  sessionId: string;
  sessionName: string | null;
}

/**
 * The coded 409 PRODUCT_IN_OPEN_COUNT: ONE open count per product. An add carries the first conflict as
 * `{ sessionId, sessionName }`; every refusal (an add, an amendment, a commit that found a legacy
 * overlap) also lists all of them as `conflicts`. Nothing was changed; the operator removes the product
 * from one of the counts.
 */
export function productInOpenCount(conflicts: OpenCountConflict[]): ConflictException {
  const first = conflicts[0];
  const where = first.sessionName ? `"${first.sessionName}"` : "another count";
  return new ConflictException({
    code: API_ERROR_CODES.PRODUCT_IN_OPEN_COUNT,
    message:
      conflicts.length === 1
        ? `${first.productName ?? "This product"} is already being counted in ${where}.`
        : `${conflicts.length} products are already being counted in other counts. Remove them from one count.`,
    sessionId: first.sessionId,
    sessionName: first.sessionName,
    conflicts: conflicts.map((c) => ({
      productId: c.productId,
      ...(c.productName ? { productName: c.productName } : {}),
      sessionId: c.sessionId,
      sessionName: c.sessionName,
    })),
  });
}

type CountSplit = number | null | undefined;
const sameSplit = (a: CountSplit, b: CountSplit) =>
  a == null || b == null ? a == null && b == null : a === b;

/**
 * SA-767 r-note 5 SA-1 (the refinement of r-note 4 A): did an ABSOLUTE write change the count? Both
 * clients resend the full `countedQty` on every edit (unit cost, mode toggle), so only a write whose
 * quantity or boxes / pieces split differs from the stored line re-stamps the baseline. The quantity
 * compares by Decimal equality (`100.000` equals `100`); a split compares as integers, null meaning
 * "no split stored".
 */
export function absoluteCountChanged(
  existing: { countedQty: Qty; boxes?: CountSplit; pieces?: CountSplit },
  next: { countedQty: Qty; boxes?: CountSplit; pieces?: CountSplit },
): boolean {
  if (!new Prisma.Decimal(existing.countedQty).eq(new Prisma.Decimal(next.countedQty))) return true;
  return !sameSplit(existing.boxes, next.boxes) || !sameSplit(existing.pieces, next.pieces);
}

/** The coded 409: the count is being committed. Nothing was changed; retry is safe. */
export function stockCountCommitting(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.STOCK_COUNT_COMMITTING,
    message: "This count is being saved. Try again in a moment.",
  });
}
