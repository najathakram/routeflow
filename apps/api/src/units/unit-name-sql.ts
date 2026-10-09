import { Prisma } from "@prisma/client";

/**
 * Every UTF-16 unit JavaScript `trim()` strips: the WhiteSpace and LineTerminator sets (TAB, LF, VT, FF,
 * CR, SPACE, NBSP, U+1680, U+2000-U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF). Spelled as
 * 4-hex `\uXXXX` escapes, the one form a PostgreSQL E-string takes for all of them: it has NO `\v`
 * escape (it reads as a literal `v`, so btrim would eat the letter), and a raw character here would
 * depend on file encoding. `unit-name-sql.spec.ts` derives the set from the JS engine and pins this
 * literal equal to it.
 */
const JS_TRIM_CODE_UNITS: readonly number[] = [
  0x0009, 0x000a, 0x000b, 0x000c, 0x000d, 0x0020, 0x00a0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003,
  0x2004, 0x2005, 0x2006, 0x2007, 0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
  0xfeff,
];
const SQL_TRIM_SET = JS_TRIM_CODE_UNITS.map((c) => `\\u${c.toString(16).padStart(4, "0")}`).join(
  "",
);

/**
 * `unitNameKey` (NFC, then trim, then case-fold; packages/pricing) for a TEXT value in SQL, so a
 * comparison made in the database agrees with the one made in TypeScript. Used wherever SQL compares a
 * unit label: the unit counts and rename candidates and the line-size checks (units.service.ts), and the
 * level-write line-size check (product-units.service.ts).
 */
export const sqlKeyOf = (ref: Prisma.Sql): Prisma.Sql =>
  Prisma.sql`lower(btrim(normalize(${ref}, NFC), E'${Prisma.raw(SQL_TRIM_SET)}'))`;
