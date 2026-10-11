/**
 * SA-767 L-2.2 (r-note 2 (b)): the vocabulary of a durable stock count that commits in batches.
 *
 * A warehouse-wide count used to be ONE transaction that locked every counted product for its whole
 * duration (a sale of any counted product waited minutes). It now commits in id-ordered batches of
 * {@link COUNT_COMMIT_BATCH} lines, each its own short transaction; the session stays OPEN / REVIEW
 * (no new enum value, no migration) until a CAS after the last batch flips it to COMMITTED. While some
 * of its movements exist and it is not COMMITTED it is "committing": a second commit, a line edit and
 * a discard are refused with 409 STOCK_COUNT_COMMITTING.
 */
import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Lines per commit transaction: bounds how long one count batch holds its Product row locks. */
export const COUNT_COMMIT_BATCH = 50;

/** The `StockMovement.reference` of every movement a count session writes (also its movementReference). */
export const stockCountReference = (sessionId: string): string => `STOCK_COUNT-${sessionId}`;

/** The coded 409: the count is being committed. Nothing was changed; retry is safe. */
export function stockCountCommitting(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.STOCK_COUNT_COMMITTING,
    message: "This count is being saved. Try again in a moment.",
  });
}
