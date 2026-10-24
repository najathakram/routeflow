/**
 * Regulated-license guard helpers: detecting the 409 block and choosing the
 * override scope (ORDER when the order exists, else a 24h UNTIL window).
 */
import {
  parseRegulatedAuthError,
  overrideScope,
  regulatedAuthErrorCopy,
} from "../lib/authorizations-logic";

describe("parseRegulatedAuthError", () => {
  it("returns the blocked categories on a REGULATED_AUTH_REQUIRED 409", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "REGULATED_AUTH_REQUIRED",
          blockedCategories: [
            { trackedCategoryId: "t1", categoryName: "Tobacco", reason: "NO_AUTH" },
          ],
        },
      },
    };
    expect(parseRegulatedAuthError(err)).toEqual([
      { trackedCategoryId: "t1", categoryName: "Tobacco", reason: "NO_AUTH" },
    ]);
  });

  it("returns null for other 409s (e.g. merge choice) and non-409s", () => {
    expect(
      parseRegulatedAuthError({
        response: { status: 409, data: { code: "MERGE_CHOICE_REQUIRED" } },
      }),
    ).toBeNull();
    expect(parseRegulatedAuthError({ response: { status: 400, data: {} } })).toBeNull();
    expect(parseRegulatedAuthError(new Error("network"))).toBeNull();
  });

  it("tolerates a REGULATED_AUTH_REQUIRED body with no categories", () => {
    expect(
      parseRegulatedAuthError({
        response: { status: 409, data: { code: "REGULATED_AUTH_REQUIRED" } },
      }),
    ).toEqual([]);
  });
});

describe("overrideScope", () => {
  it("uses ORDER scope when an orderId is present", () => {
    expect(overrideScope("order-123", 1_000_000)).toBe("ORDER:order-123");
  });

  it("uses a +24h UNTIL window when there is no order yet", () => {
    const now = 1_000_000;
    const scope = overrideScope(undefined, now);
    expect(scope).toBe(`UNTIL:${new Date(now + 24 * 60 * 60 * 1000).toISOString()}`);
  });
});

describe("regulatedAuthErrorCopy (CQ-06): the shared license-refusal sentence, never raw server text", () => {
  const e = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

  it("an expired license says so and names the next step", () => {
    const copy = regulatedAuthErrorCopy(
      e(409, {
        code: "REGULATED_AUTH_REQUIRED",
        message: "Conflict Exception",
        blockedCategories: [
          { trackedCategoryId: "t1", categoryName: "Alcohol", reason: "EXPIRED" },
        ],
      }),
    );
    expect(copy).toBe(
      "This sale includes regulated items (Alcohol), and the customer's license has expired. Renew it on the customer's Licenses tab, then try again.",
    );
  });

  it("a body with no categories still gets the license sentence (the empty-list fallback)", () => {
    expect(regulatedAuthErrorCopy(e(409, { code: "REGULATED_AUTH_REQUIRED" }))).toContain(
      "Licenses tab",
    );
  });

  it("null for any other error", () => {
    expect(regulatedAuthErrorCopy(e(409, { code: "MERGE_CHOICE_REQUIRED" }))).toBeNull();
    expect(regulatedAuthErrorCopy(new Error("network"))).toBeNull();
  });
});
