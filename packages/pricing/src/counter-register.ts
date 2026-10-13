// ─── Counter register ────────────────────────────────────────────────────────────────────────────────────────────────
//
// ONE source for the register a counter request names when it names none, and for what a register key may look like.
// Every counter feature that is keyed by a register (quick keys, parked sales, and the day close / `Order.registerKey`
// to come) reads these two; none keeps its own copy. It lives in @routeflow/pricing because the API value-imports this
// package but never @routeflow/types (L-261).

/** The register a request names when it names none (or an unknown one). One register in v1. */
export const COUNTER_DEFAULT_REGISTER = "main";

/**
 * What a register key may look like: 1..64 characters of letters, digits, underscore and dash, with ':' allowed after
 * the first character (so a namespaced key like `store:2` works, and `:x` does not). Case-sensitive: `Front-1` and
 * `front-1` are two registers. This is the ONE union pattern; park, quick keys and the day close all share it, none
 * keeps a local regex. No flags, so `$` never matches before a trailing newline.
 */
export const REGISTER_KEY_PATTERN = /^[A-Za-z0-9_-][A-Za-z0-9:_-]{0,63}$/;
