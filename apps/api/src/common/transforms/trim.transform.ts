/**
 * Trims a string value (leading and trailing whitespace); a non-string passes through unchanged and is
 * left for the validators to reject. class-transformer applies a property's @Transform decorators in the
 * order they are LISTED (top first), so list `@StripHtml()` ABOVE `@Trim()`: the text is trimmed after any
 * tag removal.
 */

import { Transform } from "class-transformer";

export function Trim() {
  return Transform(({ value }) => (typeof value === "string" ? value.trim() : value));
}
