import { classifyShareError } from "../lib/share-error";

/**
 * Pins the iOS Safari share contract (customer report 2026-08-25: "can't
 * share an invoice via phone, works on desktop"): a NotAllowedError from
 * `navigator.share()` means the transient-activation window didn't survive
 * the PDF fetch — the file is cached and ready, so it must route to the
 * "tap again to share" recovery, NEVER to a hard failure toast. AbortError
 * stays "user dismissed the sheet" and everything else stays a real failure.
 */
describe("classifyShareError", () => {
  it("routes NotAllowedError (iOS expired activation) to the retap recovery", () => {
    expect(classifyShareError("NotAllowedError")).toBe("retap");
  });

  it("treats AbortError as a dismissed share sheet, not an error", () => {
    expect(classifyShareError("AbortError")).toBe("dismissed");
  });

  it("treats everything else as a real failure", () => {
    expect(classifyShareError("TypeError")).toBe("failed");
    expect(classifyShareError("DataError")).toBe("failed");
    expect(classifyShareError("")).toBe("failed");
    expect(classifyShareError(undefined)).toBe("failed");
    expect(classifyShareError(null)).toBe("failed");
  });
});
