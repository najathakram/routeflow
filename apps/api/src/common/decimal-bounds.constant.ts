/**
 * B2191: the max value a Postgres `Decimal(10, 2)` column can store —
 * 10 total digits, 2 after the decimal point → 99,999,999.99. Any value at or
 * above 100,000,000 fails the column's precision at the DB layer with a raw
 * Prisma error (surfaced as an unhandled 500), so every DTO field backed by
 * such a column must validate against this bound BEFORE the write, not rely
 * on Postgres to reject it.
 */
export const MAX_DECIMAL_10_2 = 99_999_999.99;
