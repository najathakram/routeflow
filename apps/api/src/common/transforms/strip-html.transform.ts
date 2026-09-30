/**
 * RF-110: utility transform for removing HTML/JS from free-text string inputs.
 *
 * Usage in DTOs:
 *   @StripHtml() businessName: string;
 */

import { Transform } from "class-transformer";
import sanitizeHtml from "sanitize-html";

/**
 * sanitize-html re-serializes surviving text nodes HTML-entity-encoded even
 * when every tag is stripped, so "Smith & Sons" came back (and was stored) as
 * "Smith &amp; Sons". The stored value is plain text, not HTML — decode the
 * five entities its serializer emits back to literal characters.
 * `&amp;` MUST be decoded last: decoding it first turns "&amp;lt;" into
 * "&lt;" which the next replace would double-decode to "<".
 */
function decodeSanitizeEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/**
 * Returns a Transform decorator that strips all HTML tags and attributes from
 * a string value.  Applied at the DTO level so no raw HTML ever reaches the
 * service layer or the database.
 *
 * The input is parsed as HTML, so entities the caller pre-escaped decode to
 * their literal characters ("a &amp; b" is stored as "a & b") — the stored
 * value is always plain text, never markup.
 */
export function StripHtml() {
  return Transform(({ value }) => {
    if (typeof value !== "string") return value;
    return decodeSanitizeEntities(sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} }));
  });
}
