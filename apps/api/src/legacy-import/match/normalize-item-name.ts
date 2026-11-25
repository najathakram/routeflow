/**
 * Match-side normaliser. Pure and one-way: it builds a COMPARISON string only.
 * The source key used for aliases and staged lines is `itemSourceKey` (never folded).
 * Segments of a "Parent:Child" name are normalised one by one and re-joined with ":".
 */
function normalizeSegment(segment: string): string {
  return segment
    .normalize("NFKC")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/(\d)(\p{L})/gu, "$1 $2")
    .replace(/(\p{L})(\d)/gu, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeItemName(raw: string): string {
  return raw
    .split(":")
    .map(normalizeSegment)
    .filter((s) => s.length > 0)
    .join(":");
}

/** The full "Parent:Child" name, trimmed and nothing else. */
export function itemSourceKey(raw: string): string {
  return raw.trim();
}
