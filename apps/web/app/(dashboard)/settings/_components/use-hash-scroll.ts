/** The `#id` as an element id; a malformed escape ("%E0") is not an id, never an exception. */
export function hashId(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ""));
  } catch {
    return "";
  }
}
