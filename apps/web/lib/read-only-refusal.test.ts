import { API_ERROR_CODES } from "@routeflow/types";
import { isReadOnlyRefusal, readOnlyRefusalCopy } from "./read-only-refusal";
import { readOnlyLine } from "./subscription-banner-state";

/**
 * The shared READ_ONLY refusal predicate + sentence. Every error-copy helper asks this BEFORE its generic 401 / 403
 * fallback, so a read-only workspace's refusal never reads as "you don't have permission".
 */
describe("isReadOnlyRefusal", () => {
  it("is true for an axios-like error whose body code is READ_ONLY", () => {
    expect(
      isReadOnlyRefusal({ response: { status: 403, data: { code: API_ERROR_CODES.READ_ONLY } } }),
    ).toBe(true);
  });

  it("tolerates the other shapes the sibling helpers take: { code } and { data: { code } }", () => {
    expect(isReadOnlyRefusal({ code: "READ_ONLY" })).toBe(true);
    expect(isReadOnlyRefusal({ data: { code: "READ_ONLY" } })).toBe(true);
  });

  it("is false for every other code, a code-less 403, and non-error values", () => {
    expect(isReadOnlyRefusal({ response: { status: 403, data: { code: "ADDON_GATE" } } })).toBe(
      false,
    );
    expect(isReadOnlyRefusal({ response: { status: 403, data: {} } })).toBe(false);
    expect(isReadOnlyRefusal({ response: { status: 403 } })).toBe(false);
    expect(isReadOnlyRefusal({ response: { status: 403, data: { message: "READ_ONLY" } } })).toBe(
      false,
    );
    for (const v of [null, undefined, "READ_ONLY", 403, {}, []])
      expect(isReadOnlyRefusal(v)).toBe(false);
  });
});

describe("readOnlyRefusalCopy", () => {
  it("is B4's readOnlyLine: the admin by name, or 'Your admin' when none is on file", () => {
    expect(readOnlyRefusalCopy("Dana")).toBe("Not available while read-only. Dana can restore it.");
    expect(readOnlyRefusalCopy()).toBe("Not available while read-only. Your admin can restore it.");
    expect(readOnlyRefusalCopy(null)).toBe(readOnlyLine(null));
    expect(readOnlyRefusalCopy("  ")).toBe(readOnlyLine("  "));
  });
});
