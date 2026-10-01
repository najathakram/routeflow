/** UTF-8 byte-order mark: lets Excel open a CSV as UTF-8 instead of the ANSI code page. */
export const CSV_BOM = "﻿";

/**
 * A leading character a spreadsheet may run as a formula: `=`, `+`, `-`, `@`, tab, CR, LF, and
 * their full-width forms (＝ ＋ － ＠), which some spreadsheet locales normalize to ASCII.
 */
const FORMULA_LEAD = /^[=+\-@\t\r\n＝＋－＠]/;

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (`FORMULA_LEAD`) is prefixed
 * with `'` (OWASP CSV injection) — customer and product names are user-typed.
 * Numbers are written as-is, so a negative amount stays numeric.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value == null) return "";
  if (typeof value !== "string") return String(value);
  const safe = FORMULA_LEAD.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV record: cells comma-joined and terminated with CRLF. */
export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}
