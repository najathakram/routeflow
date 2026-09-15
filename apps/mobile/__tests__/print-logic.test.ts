import { classifyPrintError, printTransport } from "../lib/print-logic";

/**
 * WP3 — pure classification/transport helpers for the mobile print flow
 * (print-pdf.ts), kept node-safe (no RN/expo imports) so they're unit
 * testable under the mobile Jest env.
 */
describe("printTransport", () => {
  it("routes web to the existing openPdfInTab tab flow (R6.5)", () => {
    expect(printTransport("web")).toBe("tab");
  });

  it("routes every native OS to expo-print", () => {
    expect(printTransport("ios")).toBe("native");
    expect(printTransport("android")).toBe("native");
  });
});

describe("classifyPrintError", () => {
  it("treats an expo-print PRINT_INCOMPLETE error code as a user dismissal", () => {
    expect(classifyPrintError({ code: "E_PRINT_INCOMPLETE" })).toBe("dismissed");
  });

  it("treats a 'did not complete' message as a dismissal (case-insensitive)", () => {
    expect(classifyPrintError({ message: "Printing did not complete" })).toBe("dismissed");
    expect(classifyPrintError({ message: "PRINTING DID NOT COMPLETE" })).toBe("dismissed");
  });

  it("treats everything else as a real failure", () => {
    expect(classifyPrintError({ code: "E_SOMETHING_ELSE" })).toBe("failed");
    expect(classifyPrintError({ message: "network error" })).toBe("failed");
    expect(classifyPrintError(null)).toBe("failed");
    expect(classifyPrintError(undefined)).toBe("failed");
    expect(classifyPrintError({})).toBe("failed");
  });
});
