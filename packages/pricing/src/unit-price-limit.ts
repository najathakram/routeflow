/**
 * SA-1067 M3: the most one unit of a line may sell for. The server's `unitPrice` DTOs and the till's price dialog
 * (`OVER_LIMIT`) both read this, so a value the server would answer with a 400 is refused where it is typed. A million
 * dollars keeps the line math inside the Decimal(10,2) the schema reserves for totals.
 */
export const MAX_UNIT_PRICE = 1_000_000;

/**
 * B1382 (SA-1281 part 3, SA-1285): the most one buyer order line may carry, in PIECES (qty, boxes or pieces). The
 * buyer shop and cart stop at it (a case line at `maxLineCount(BUYER_LINE_QTY_MAX, unitsPerBox)` cases), and the
 * server's buyer DTOs refuse above it, so a number the server would answer with a 400 is refused where it is typed.
 */
export const BUYER_LINE_QTY_MAX = 100_000;
