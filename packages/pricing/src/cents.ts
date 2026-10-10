import { roundMoney } from "./pricing";

/**
 * Dollars -> integer cents for a Stripe amount (SA-733 D9): the ONE helper every billing call uses,
 * so a hand-written `* 100` can never move a cent. The amount is rounded to cents first
 * ({@link roundMoney}), then scaled, so float noise (`0.1 + 0.2`, `19.99 * 100`) is gone.
 *
 * Unlike `roundMoney` (which turns NaN into 0), this REFUSES what is not a real price: a non-finite
 * amount, an empty string, or a negative one throws, so a bad input fails loudly before it reaches a
 * Stripe call instead of billing $0. Accepts a numeric string (a Decimal column read as text).
 */
export function toCents(dollars: number | string): number {
  const n = typeof dollars === "string" ? (dollars.trim() === "" ? NaN : Number(dollars)) : dollars;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    throw new RangeError(`toCents: not a finite amount: ${String(dollars)}`);
  }
  if (n < 0) throw new RangeError(`toCents: a price cannot be negative: ${n}`);
  return Math.round(roundMoney(n) * 100);
}

/**
 * Integer cents -> a dollar figure, rounded like every other money write. Stripe amounts are whole
 * cents, so a fractional or non-finite input is a bug upstream and throws. Negative whole cents are
 * allowed (a credit line).
 */
export function fromCents(cents: number): number {
  if (!Number.isInteger(cents)) {
    throw new RangeError(`fromCents: not whole cents: ${String(cents)}`);
  }
  return roundMoney(cents / 100);
}
