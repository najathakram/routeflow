/**
 * Splits a free-text line note into list entries when it reads like a list of items and
 * quantities ("ACME MINT 20 BOX, ACME ICE 10"). Returns null when it reads like a sentence, so
 * the caller prints the note exactly as typed. Words are never changed, only cut at separators.
 *
 * Separators: comma, semicolon, line break. A comma between two digits ("1,000") is not one.
 * A list needs 2+ entries and at least half of them carrying a digit.
 */
export function splitLineNote(note: string): string[] | null {
  const parts = note
    .split(/(?<!\d),|,(?!\d)|;|\r?\n|\r/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  if (parts.length < 2) return null;
  const withDigit = parts.filter((p) => /\d/.test(p)).length;
  return withDigit * 2 >= parts.length ? parts : null;
}
