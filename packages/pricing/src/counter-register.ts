// ─── Counter register ────────────────────────────────────────────────────────────────────────────────────────────────
//
// ONE source for the register a counter request names when it names none, and for what a register key may look like.
// Every counter feature that is keyed by a register (quick keys, parked sales, and the day close / `Order.registerKey`
// to come) reads these two; none keeps its own copy. It lives in @routeflow/pricing because the API value-imports this
// package but never @routeflow/types (L-261).

/** The register a request names when it names none (or an unknown one). One register in v1. */
export const COUNTER_DEFAULT_REGISTER = "main";

/**
 * A register key: 1..64 characters of letters, digits, `_` and `-`, and `:` after the first character (a later `driver:<id>`
 * cash-up uses the same shape). The union of every pattern a register-aware feature has used, so no existing key becomes invalid.
 * Case-sensitive: never lower-case a key.
 */
export const REGISTER_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,63}$/;
