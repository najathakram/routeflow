/** UTF-8 byte-order mark: lets Excel open a CSV as UTF-8 instead of the ANSI code page. */
export const CSV_BOM = "﻿";

/**
 * A leading character a spreadsheet may run as a formula: `=`, `+`, `-`, `@`, tab, CR, LF, and
 * their full-width forms (＝ ＋ － ＠), which some spreadsheet locales normalize to ASCII.
 */
export const FORMULA_LEAD = /^[=+\-@\t\r\n＝＋－＠]/;

/**
 * Numeric-only text a spreadsheet reads as a number or a phone, never a formula (SA-629c): one
 * optional leading sign, then only digits, spaces, `(` `)` `.` `-`, with at least one digit. No
 * letters (so not `1e5`) and none of `= @ | ! : ; % ,`, quotes, TAB or CR.
 */
export const PLAIN_DECIMAL = /^[+-]?(?=[^0-9]*[0-9])[0-9 ().-]+$/;

export interface CsvCellOptions {
  /**
   * Formula-injection guard (default ON). Turn it OFF only for regulator/audit artifacts that
   * must be byte-verbatim (SA-629): the cell is then only quoted when it holds a comma, quote or
   * newline, exactly like the old private escapers.
   */
  guard?: boolean;
}

/**
 * One CSV cell. Text that a spreadsheet would run as a formula (`FORMULA_LEAD`) is prefixed
 * with `'` (OWASP CSV injection) — customer and product names are user-typed. The ONE
 * exemption is numeric-only text (`PLAIN_DECIMAL`: `-12.50`, `+1 555 123 4567`, `(555) 123-4567`):
 * it cannot run as a formula, so it stays clean.
 * Numbers (not text) are written as-is, so a negative amount stays numeric.
 */
export function csvCell(
  value: string | number | boolean | null | undefined,
  options: CsvCellOptions = {},
): string {
  if (value == null) return "";
  if (typeof value !== "string") return String(value);
  const guard = options.guard !== false;
  const safe =
    guard && FORMULA_LEAD.test(value) && !PLAIN_DECIMAL.test(value) ? `'${value}` : value;
  // Verbatim mode quotes on comma, quote and LF only: byte-identical to the legacy regulated and
  // tobacco escapers it replaces (a bare CR was never quoted there).
  const needsQuotes = guard ? /[",\n\r]/.test(safe) : /[",\n]/.test(safe);
  return needsQuotes ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV record: cells comma-joined and terminated with CRLF. */
export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return `${cells.map((c) => csvCell(c)).join(",")}\r\n`;
}
