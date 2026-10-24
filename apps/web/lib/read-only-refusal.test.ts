import { READ_ONLY_SENTENCE } from "@routeflow/types/read-only-copy";
import { API_ERROR_CODES } from "@routeflow/types";
import { isReadOnlyRefusal, readOnlyRefusalCopy, showReadOnlyRefusal } from "./read-only-refusal";
import { isReadOnlyRefused, resetReadOnlyRefusedForTests } from "./read-only-gate";
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
  const view = (over: Record<string, unknown> = {}) =>
    ({ status: "READ_ONLY", billingContactEmail: "dana@example.test", ...over }) as never;

  it("is the shared read-only line: the owner's sentence alone when no view is held", () => {
    expect(readOnlyRefusalCopy()).toBe(READ_ONLY_SENTENCE);
    expect(readOnlyRefusalCopy(null)).toBe(readOnlyLine(null, false));
  });

  it("with the view: the sentence, the reason, and who to ask by e-mail (never a name) for a non-admin", () => {
    const text = readOnlyRefusalCopy(view({ readOnlyReason: "trial_expired" }));
    expect(text).toBe(
      `${READ_ONLY_SENTENCE} Your free trial has ended. To restore access, contact your admin (dana@example.test).`,
    );
    expect(text).not.toMatch(/Dana\b/);
  });

  it("an admin is not told to contact anyone", () => {
    expect(readOnlyRefusalCopy(view({ readOnlyReason: "trial_expired" }), true)).toBe(
      `${READ_ONLY_SENTENCE} Your free trial has ended.`,
    );
  });
});

describe("showReadOnlyRefusal (a raw apiClient write that is not a mutation)", () => {
  afterEach(() => resetReadOnlyRefusedForTests());
  const refusal = {
    response: { status: 403, data: { code: "READ_ONLY", reason: "trial_expired" } },
  };

  it("a READ_ONLY refusal: the shared line (sentence + reason) as a toast, the gate flips, true is returned", () => {
    const toast = jest.fn();
    expect(showReadOnlyRefusal(refusal, toast)).toBe(true);
    expect(toast).toHaveBeenCalledTimes(1);
    expect(toast.mock.calls[0][0]).toMatchObject({
      title: READ_ONLY_SENTENCE,
      description: "Your free trial has ended.",
      variant: "warning",
    });
    expect(isReadOnlyRefused()).toBe(true);
  });

  it("any other error: false, no toast, the gate untouched (the caller shows its own)", () => {
    const toast = jest.fn();
    expect(showReadOnlyRefusal({ response: { status: 500, data: {} } }, toast)).toBe(false);
    expect(showReadOnlyRefusal(new Error("boom"), toast)).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(isReadOnlyRefused()).toBe(false);
  });
});
