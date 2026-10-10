/**
 * The till a counter sale, a day close, a parked cart or a quick-key set belongs to (R20-10: one till in v1, so every order reads
 * as {@link COUNTER_DEFAULT_REGISTER}). The API keeps a literal copy of both constants because it never value-imports this package
 * (L-261); `apps/api/src/orders/counter-sale/day-close/register-key-parity.spec.ts` pins the copy to this file.
 */
export const COUNTER_DEFAULT_REGISTER = "main";

/**
 * A register key: 1..64 characters of letters, digits, `_` and `-`, and `:` after the first character (a later `driver:<id>`
 * cash-up uses the same shape). The union of every pattern a register-aware feature has used, so no existing key becomes invalid.
 * Case-sensitive: never lower-case a key.
 */
export const REGISTER_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,63}$/;
