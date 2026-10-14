/**
 * Trims a string value (leading and trailing whitespace); a non-string passes through unchanged and is
 * left for the validators to reject. Listed ABOVE `@StripHtml()` on a property so the strip runs first
 * (decorators apply bottom-up) and the stored text is trimmed after any tag removal.
 */

import { Transform } from "class-transformer";

export function Trim() {
  return Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
}
