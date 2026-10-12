/**
 * `lib/order-revision-guard.ts` — row 262, the mobile half of the order revision guard.
 * Pure decisions only: is this error the stale-revision 409, which fixed copy to show,
 * which revision the editor holds, and what goes on the PATCH body.
 */
import {
  ORDER_STALE_COPY,
  captureOpenRevision,
  expectedRevisionBody,
  isOrderRevisionStale,
  rebaseRevision,
} from "../lib/order-revision-guard";

const err = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("isOrderRevisionStale", () => {
  it("is true for a 409 carrying ORDER_REVISION_STALE", () => {
    expect(isOrderRevisionStale(err(409, { code: "ORDER_REVISION_STALE" }))).toBe(true);
  });
  it("leaves other 409 codes alone", () => {
    expect(isOrderRevisionStale(err(409, { code: "REGULATED_AUTH_REQUIRED" }))).toBe(false);
    expect(isOrderRevisionStale(err(409, {}))).toBe(false);
  });
  it("needs the 409 status as well as the code", () => {
    expect(isOrderRevisionStale(err(400, { code: "ORDER_REVISION_STALE" }))).toBe(false);
  });
  it("tolerates non-axios errors", () => {
    expect(isOrderRevisionStale(null)).toBe(false);
    expect(isOrderRevisionStale(new Error("boom"))).toBe(false);
    expect(isOrderRevisionStale({ response: {} })).toBe(false);
  });
});

describe("ORDER_STALE_COPY", () => {
  it("is the fixed sentence, never server text", () => {
    expect(ORDER_STALE_COPY).toBe(
      "This order changed since you opened it. Reload to see the latest.",
    );
  });
});

describe("captureOpenRevision", () => {
  it("captures the first known revision", () => {
    expect(captureOpenRevision(undefined, 4)).toBe(4);
  });
  it("never moves once captured (a refetch while typing must not re-base)", () => {
    expect(captureOpenRevision(4, 7)).toBe(4);
  });
  it("stays unknown while the order has no revision", () => {
    expect(captureOpenRevision(undefined, undefined)).toBeUndefined();
  });
  it("ignores a non-integer live value", () => {
    expect(captureOpenRevision(undefined, 1.5)).toBeUndefined();
    expect(captureOpenRevision(undefined, "3" as unknown as number)).toBeUndefined();
  });
});

describe("rebaseRevision", () => {
  it("adopts the freshly loaded revision on an explicit reload", () => {
    expect(rebaseRevision(9)).toBe(9);
  });
  it("is unknown when the reload did not return one", () => {
    expect(rebaseRevision(undefined)).toBeUndefined();
  });
});

describe("expectedRevisionBody", () => {
  it("includes expectedRevisionNumber when known", () => {
    expect(expectedRevisionBody(5)).toEqual({ expectedRevisionNumber: 5 });
    expect(expectedRevisionBody(0)).toEqual({ expectedRevisionNumber: 0 });
  });
  it("omits it when unknown or not an integer", () => {
    expect(expectedRevisionBody(undefined)).toEqual({});
    expect(expectedRevisionBody(Number.NaN)).toEqual({});
    expect(expectedRevisionBody(2.5)).toEqual({});
  });
});
