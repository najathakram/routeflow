/**
 * SA-816 (d)3 / register row 593: the guard every script runs before it BINDS a money value into raw SQL.
 *
 * Why: node-pg sends a JS NaN as the text 'NaN', and a Postgres NUMERIC column accepts it. A one-off repair
 * script once wrote numeric NaN into 101 `InvoiceItem.categoryTaxAmount` rows that way (an unquoted camelCase
 * alias folded to lower case, so the value read back `undefined`, and `round2(undefined)` is NaN). The app's
 * strict path refuses a non-finite amount with MONEY_INVARIANT; this is the same rule for scripts.
 *
 * `assertFiniteMoney(value, label)` returns `value` unchanged when it is a finite number, or a string / Decimal
 * (anything whose text is a plain finite decimal, which is what pg hands back for NUMERIC) that reads as one.
 * It THROWS for NaN, +/-Infinity, undefined, null, '', 'NaN', and anything that is not a number. `null` is
 * refused too: a script that means to write SQL NULL binds a literal NULL and does not call this.
 *
 * Consumed by (the pin is apps/api/src/common/script-money-writers.spec.ts):
 *  - scripts/*.mjs               -> import { assertFiniteMoney } from "./lib/assert-finite-money.cjs"
 *  - apps/api/scripts/*.mjs      -> import { assertFiniteMoney } from "../../../scripts/lib/assert-finite-money.cjs"
 *  - apps/api/scripts/*.js       -> require("../../../scripts/lib/assert-finite-money.cjs")
 *
 * Keep exports static (plain `module.exports = { ... }`) so Node's CJS->ESM named-export interop keeps working.
 */
"use strict";

/** A plain finite decimal as text: optional sign, digits with an optional fraction, optional exponent. */
const DECIMAL_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

function readNumber(value) {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  let text = null;
  if (typeof value === "string") text = value;
  // A Decimal (Prisma / decimal.js) or any other object that prints as a number; a plain object prints as
  // "[object Object]" and fails the pattern below.
  else if (value !== null && typeof value === "object") text = String(value);
  if (text === null) return NaN;
  const trimmed = text.trim();
  return DECIMAL_TEXT.test(trimmed) ? Number(trimmed) : NaN;
}

function describe(value) {
  if (typeof value === "string") return JSON.stringify(value);
  try {
    return String(value);
  } catch {
    return Object.prototype.toString.call(value);
  }
}

/**
 * @param {unknown} value the money value about to be bound
 * @param {string} label  what it is, e.g. `InvoiceItem ii-1 categoryTaxAmount`
 * @returns {unknown} `value`, unchanged
 */
function assertFiniteMoney(value, label) {
  if (Number.isFinite(readNumber(value))) return value;
  const err = new TypeError(
    `assertFiniteMoney: ${label}: refusing to bind ${describe(value)} as a money value. ` +
      `node-pg sends NaN as 'NaN' and NUMERIC accepts it (SA-816); nothing was written.`,
  );
  err.name = "NonFiniteMoneyError";
  throw err;
}

module.exports = { assertFiniteMoney };
