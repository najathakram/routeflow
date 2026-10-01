/** UTF-8 byte-order mark: lets Excel open a CSV as UTF-8 instead of the ANSI code page. */
export const CSV_BOM = "﻿";

/**
 * A leading character a spreadsheet may run as a formula: `=`, `+`, `-`, `@`, tab, CR, LF, and
 * their full-width forms (＝ ＋ － ＠), which some spreadsheet locales normalize to ASCII.
 */
const FORMULA_LEAD = /^[=+\-@\t\r\n＝＋－＠]/;

/** A plain decimal number as text (`-12.50`): a spreadsheet reads it as a number, never a formula. */
const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

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
 * exemption is a plain decimal number written as text (`/^-?\d+(\.\d+)?$/`, e.g. the
 * `-12.50` of a formatted refund amount): it cannot run as a formula, so it stays numeric.
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
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** One CSV record: cells comma-joined and terminated with CRLF. */
export function csvRow(cells: (string | number | boolean | null | undefined)[]): string {
  return `${cells.map(csvCell).join(",")}\r\n`;
}
