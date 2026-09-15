// Node-safe (no RN/expo imports) — kept unit-testable under the mobile Jest
// env (see jest.config.js: pure-logic only). print-pdf.ts imports these.

/**
 * Classifies an expo-print `Print.printAsync` rejection. Mirrors
 * `share-error.ts`'s `classifyShareError` contract for the print flow:
 * `Print.printAsync` rejects with a `PRINT_INCOMPLETE`-suffixed error code
 * (and/or a "did not complete" message) when the user dismisses the native
 * print dialog without printing — that's not a real failure and must not be
 * toasted as one.
 */
export function classifyPrintError(
  err: { code?: string | null; message?: string | null } | null | undefined,
): "dismissed" | "failed" {
  return /PRINT_INCOMPLETE$/.test(err?.code ?? "") || /did not complete/i.test(err?.message ?? "")
    ? "dismissed"
    : "failed";
}

/** Which transport a given `Platform.OS` should print through (R6.5). */
export function printTransport(os: string): "tab" | "native" {
  return os === "web" ? "tab" : "native";
}
