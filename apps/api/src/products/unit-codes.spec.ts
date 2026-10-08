import { CODE_MAX_LENGTH, normalizeCode, CodeValidationError } from "./unit-codes";

describe("normalizeCode (SA-729d shared validator)", () => {
  it("trims, and treats blank as 'no code'", () => {
    expect(normalizeCode("  ABC-1 ")).toBe("ABC-1");
    expect(normalizeCode("   ")).toBeNull();
    expect(normalizeCode(null)).toBeNull();
    expect(normalizeCode(undefined)).toBeNull();
  });

  it("accepts exactly 64 characters and rejects 65 on a new code", () => {
    expect(normalizeCode("a".repeat(CODE_MAX_LENGTH))).toHaveLength(64);
    expect(() => normalizeCode("a".repeat(65))).toThrow(CodeValidationError);
    expect(() => normalizeCode("a".repeat(65))).toThrow("Keep it to 64 characters or fewer.");
  });

  it("rejects control characters and internal newlines", () => {
    expect(() => normalizeCode("ab\ncd")).toThrow(CodeValidationError);
    expect(() => normalizeCode("ab\u0000cd")).toThrow(CodeValidationError);
    expect(() => normalizeCode("ab\tcd")).toThrow(CodeValidationError);
  });

  it("a stored legacy value over 64 chars is accepted unchanged on re-save", () => {
    const legacy = "L".repeat(80);
    expect(normalizeCode(legacy, { existing: legacy })).toBe(legacy);
    // ... but a CHANGED long value is still refused
    expect(() => normalizeCode("M".repeat(80), { existing: legacy })).toThrow(CodeValidationError);
  });
});
