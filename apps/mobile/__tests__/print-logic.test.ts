import { classifyPrintError, isDownloadOk, printTransport } from "../lib/print-logic";

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

describe("isDownloadOk (review finding F2 on PR #756)", () => {
  it("accepts every 2xx status", () => {
    expect(isDownloadOk(200)).toBe(true);
    expect(isDownloadOk(201)).toBe(true);
    expect(isDownloadOk(299)).toBe(true);
  });

  it("rejects a redirect, a client error and a server error", () => {
    expect(isDownloadOk(301)).toBe(false);
    expect(isDownloadOk(404)).toBe(false);
    expect(isDownloadOk(500)).toBe(false);
  });

  it("rejects the exact boundary values (200 is in, 300 is out)", () => {
    expect(isDownloadOk(199)).toBe(false);
    expect(isDownloadOk(300)).toBe(false);
  });
});
