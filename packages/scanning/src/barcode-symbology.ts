import type { BARCODE_SYMBOLOGY_VALUES } from "@routeflow/types";

/** One member of `BARCODE_SYMBOLOGY_VALUES` (the shared, Prisma-parity-pinned enum mirror). */
type BarcodeSymbology = (typeof BARCODE_SYMBOLOGY_VALUES)[number];

/**
 * #2717 M1 (SA-572a): infers the barcode symbology purely from the trimmed code's digit-length —
 * 12 digits UPC_A, 13 EAN_13, 14 GTIN_14, 8 EAN_8; any other digit-only length, or any non-digit
 * code, falls back to CODE128 (SA-572b Q1). No check-digit validation.
 * Moved from apps/api/src/common in M4a-1; typed by BARCODE_SYMBOLOGY_VALUES.
 */
export function inferBarcodeSymbology(code: string): BarcodeSymbology {
  const trimmed = code.trim();
  if (/^\d+$/.test(trimmed)) {
    switch (trimmed.length) {
      case 12:
        return "UPC_A";
      case 13:
        return "EAN_13";
      case 14:
        return "GTIN_14";
      case 8:
        return "EAN_8";
      default:
        return "CODE128";
    }
  }
  return "CODE128";
}
