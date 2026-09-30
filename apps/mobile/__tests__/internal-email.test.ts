import { displayEmail, isInternalEmail, NO_EMAIL_COPY } from "../lib/internal-email";

describe("isInternalEmail (mobile mirror)", () => {
  it("flags the CSV-import sentinel domain", () => {
    expect(isInternalEmail("acme_store@imported.local")).toBe(true);
  });

  it("flags the no-email placeholder sentinel domain", () => {
    expect(isInternalEmail("no-email+123e4567@placeholder.local")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isInternalEmail("SOMEONE@IMPORTED.LOCAL")).toBe(true);
  });

  it("passes real addresses through", () => {
    expect(isInternalEmail("billing@acmeco.com")).toBe(false);
    expect(isInternalEmail("owner@imported.localhost.com")).toBe(false);
  });

  it("is false for empty/null/undefined", () => {
    expect(isInternalEmail("")).toBe(false);
    expect(isInternalEmail(null)).toBe(false);
    expect(isInternalEmail(undefined)).toBe(false);
  });
});

describe("displayEmail (render gate, web mirror) — sentinels and absent are both null", () => {
  it("passes a real address through", () => {
    expect(displayEmail("billing@acmeco.com")).toBe("billing@acmeco.com");
  });

  it.each(["acme_store@imported.local", "no-email+x@placeholder.local"])(
    "%s renders as no-email (null)",
    (sentinel) => {
      expect(displayEmail(sentinel)).toBeNull();
    },
  );

  it("absent values are null too, so sites fall to the shared empty copy", () => {
    expect(displayEmail(null)).toBeNull();
    expect(displayEmail(undefined)).toBeNull();
    expect(displayEmail("")).toBeNull();
    expect(displayEmail("someone@imported.local") ?? NO_EMAIL_COPY).toBe(NO_EMAIL_COPY);
  });

  it("the empty copy is the one fixed string", () => {
    expect(NO_EMAIL_COPY).toBe("No email");
  });
});
