/**
 * Pure (screen-free, testable) helpers behind MoneyTextInput — the fix for
 * money fields that reformat while typing ("2." collapsing to "2", "2.50"
 * becoming "2.05"). NOT in lib/pricing.ts on purpose: that file is a
 * hand-synced three-way mirror and these helpers are mobile-only UI plumbing.
 */

/**
 * Sanitize a money draft while typing: comma → dot, strip non-numerics, keep
 * one dot, clamp to `decimals` places, normalize a leading "." to "0.".
 * Crucially PRESERVES intermediate states like "2." and "".
 */
export function sanitizeMoneyInput(raw: string, decimals = 2): string {
  let out = "";
  let seenDot = false;
  for (const ch of raw.replace(/,/g, ".")) {
    if (ch >= "0" && ch <= "9") out += ch;
    else if (ch === "." && !seenDot && decimals > 0) {
      seenDot = true;
      out += ".";
    }
  }
  if (out.startsWith(".")) out = `0${out}`;
  if (seenDot) {
    const [whole, frac = ""] = out.split(".");
    out = `${whole}.${frac.slice(0, decimals)}`;
  }
  return out;
}

/** Parse a sanitized draft; "" (and lone "0.") stay null-safe for "no value". */
export function parseMoney(text: string): number | null {
  if (text.trim() === "") return null;
  const n = parseFloat(text);
  return Number.isFinite(n) ? n : null;
}
