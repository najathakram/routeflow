import { Prisma } from "@prisma/client";

/**
 * `unitNameKey` (NFC, then trim, then case-fold; packages/pricing) for a TEXT value in SQL, so a
 * comparison made in the database agrees with the one made in TypeScript. btrim gets the whitespace
 * set JS `trim()` strips most often (space, tab, newline, CR, FF, VT as \x0B because E-strings have
 * no \v, NBSP). Used wherever SQL compares a unit label: the unit counts and rename candidates
 * (units.service.ts) and the line-size immutability checks (units.service.ts rename,
 * product-units.service.ts).
 */
export const sqlKeyOf = (ref: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`lower(btrim(normalize(${ref}, NFC), E' \\t\\n\\r\\f\\x0B\\u00a0'))`;
