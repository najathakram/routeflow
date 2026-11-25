// One issue row (SA-1295: every problem is a row with the physical line number). Shared by the
// decoder, the parser, the adapters and the grouper; the staging PR maps it to LegacyImportIssue.

export type LegacyIssueCode =
  | "LEADING_BYTE_STRIPPED"
  | "ROW_SHORT"
  | "ROW_LONG"
  | "BAD_MONEY"
  | "BAD_QUANTITY"
  | "BAD_DATE"
  | "BLANK_DOCUMENT_NUMBER"
  | "BLANK_CUSTOMER"
  | "BLANK_CUSTOMER_INHERITED"
  | "CUSTOMER_CONFLICT"
  | "DOCUMENT_DATE_CONFLICT"
  | "MISSING_DATE";

export interface LegacyIssue {
  severity: "ERROR" | "WARNING";
  code: LegacyIssueCode;
  message: string;
  /** 1-based record number counting the header as record 1; null for a whole-file issue. */
  recordNo: number | null;
  /** 1-based physical line where the record starts; null for a whole-file issue. */
  physicalLine: number | null;
  sourceDocKey?: string;
}

/** A failure that stops the whole file (the job fails loud; it never returns a silent empty set). */
export type LegacyParseErrorCode = "INVALID_UTF8" | "CSV_SYNTAX" | "EMPTY_FILE" | "UNKNOWN_SHAPE";

export class LegacyParseError extends Error {
  constructor(
    readonly code: LegacyParseErrorCode,
    message: string,
    readonly physicalLine: number | null = null,
  ) {
    super(message);
    this.name = "LegacyParseError";
  }
}
