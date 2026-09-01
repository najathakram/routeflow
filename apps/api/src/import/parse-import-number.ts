import { roundMoney } from "../common/pricing";

/**
 * Parse a number column from an imported CSV (Zoho/QuickBooks/Excel exports).
 * Strips currency symbols, thousands-separator commas and spaces before parsing.
 * Returns NaN when the cell is empty, non-numeric or not a string/number —
 * callers rely on NaN to detect ABSENCE (the Balance-Due status logic), so
 * never default to 0 here. csv-parse only ever hands us strings.
 */
export function parseImportNumber(raw: unknown): number {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return NaN;
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (cleaned === "") return NaN;
  return parseFloat(cleaned);
}

/** parseImportNumber + cent rounding for monetary columns. NaN passes through. */
export function parseImportMoney(raw: unknown): number {
  const n = parseImportNumber(raw);
  return Number.isFinite(n) ? roundMoney(n) : n;
}
