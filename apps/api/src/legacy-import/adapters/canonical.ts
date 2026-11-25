// Canonical rows an adapter produces from one source record (SA-1295 A1). Money is a number of
// dollars in whole cents, read strictly; a line total is the FILE's total, never quantity x price.

export type LineDefectCode = "BAD_MONEY" | "BAD_QUANTITY" | "BAD_DATE";

export interface LineDefect {
  code: LineDefectCode;
  column: string;
  message: string;
}

export interface CanonicalLine {
  /** 1-based, the header is record 1. */
  recordNo: number;
  /** 1-based physical line where the record starts. */
  physicalLine: number;
  /** Trimmed source document number; "" when blank. */
  docNumber: string;
  /** Trimmed, verbatim customer text (full Parent:Job form); "" when blank. */
  customerName: string;
  /** ISO yyyy-mm-dd; null when blank or refused (a refusal also adds a defect). */
  issueDate: string | null;
  itemName: string | null;
  /** Verbatim, line breaks kept. */
  description: string | null;
  /** null when the file has none: never defaulted to 1. */
  quantity: number | null;
  unitPrice: number | null;
  /** The file's Total. null when blank: never rebuilt. */
  total: number | null;
  sku: string | null;
  defects: LineDefect[];
}

export type LineKind = "PRODUCT" | "SHIPPING" | "DISCOUNT" | "NOTE" | "OTHER";
