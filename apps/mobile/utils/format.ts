/** Safe currency formatter — handles null, undefined, NaN, and string inputs. */
export function fmtCurrency(n: number | string | null | undefined): string {
  const v = n == null ? 0 : typeof n === "string" ? Number(n) : n;
  return `$${(Number.isFinite(v) ? v : 0).toFixed(2)}`;
}

/** Safe date formatter — handles null, undefined, and full ISO strings without double-suffixing. */
export function fmtDate(
  s: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric", year: "numeric" },
): string {
  if (!s) return "—";
  const d = new Date(s);
  return isNaN(d.getTime()) ? "—" : d.toLocaleDateString(undefined, opts);
}

export function fmtDateLong(s: string | null | undefined): string {
  return fmtDate(s, { month: "long", day: "numeric", year: "numeric" });
}
