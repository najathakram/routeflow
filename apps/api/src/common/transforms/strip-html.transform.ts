/**
 * RF-110: utility transform for removing HTML/JS from free-text string inputs.
 *
 * Usage in DTOs:
 *   @StripHtml() businessName: string;
 */

import { Transform } from "class-transformer";
import sanitizeHtml from "sanitize-html";

/**
 * Returns a Transform decorator that strips all HTML tags and attributes from
 * a string value.  Applied at the DTO level so no raw HTML ever reaches the
 * service layer or the database.
 */
export function StripHtml() {
  return Transform(({ value }) => {
    if (typeof value !== "string") return value;
    return sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
  });
}
