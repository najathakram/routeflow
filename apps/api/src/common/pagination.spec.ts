import { clampLimit, MAX_LIST_LIMIT } from "./pagination";

describe("clampLimit (F9-001/002/003 pagination bound)", () => {
  it("returns the fallback for missing/invalid input", () => {
    expect(clampLimit(undefined, 25)).toBe(25);
    expect(clampLimit(null, 25)).toBe(25);
    expect(clampLimit(NaN, 25)).toBe(25);
    expect(clampLimit(0, 25)).toBe(25);
    expect(clampLimit(-5, 25)).toBe(25);
  });

  it("passes through a normal in-range limit (floored)", () => {
    expect(clampLimit(50, 25)).toBe(50);
    expect(clampLimit(999, 25)).toBe(999);
    expect(clampLimit(50.9, 25)).toBe(50);
  });

  it("caps an abusive limit at MAX_LIST_LIMIT", () => {
    expect(clampLimit(100_000, 25)).toBe(MAX_LIST_LIMIT);
    expect(clampLimit(Number.MAX_SAFE_INTEGER, 25)).toBe(MAX_LIST_LIMIT);
    expect(clampLimit(MAX_LIST_LIMIT + 1, 25)).toBe(MAX_LIST_LIMIT);
  });

  it("honors a caller-supplied lower ceiling", () => {
    expect(clampLimit(500, 25, 100)).toBe(100);
    expect(clampLimit(80, 25, 100)).toBe(80);
  });
});
