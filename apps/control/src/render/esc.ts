/** HTML escaping for every dynamic string the renderer interpolates (T25). Total: never throws. */
const MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function esc(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s =
    typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? `${v}` : "";
  return s.replace(/[&<>"']/g, (c) => MAP[c]);
}
