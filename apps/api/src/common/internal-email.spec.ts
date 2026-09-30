import { isInternalEmail } from "./internal-email";

describe("isInternalEmail", () => {
  it("flags the CSV-import sentinel domain", () => {
    expect(isInternalEmail("flash_mart@imported.local")).toBe(true);
  });

  it("flags the no-email placeholder sentinel domain", () => {
    expect(isInternalEmail("no-email+123e4567@placeholder.local")).toBe(true);
  });

  it("is case-insensitive", () => {
    expect(isInternalEmail("SOMEONE@IMPORTED.LOCAL")).toBe(true);
    expect(isInternalEmail("x@Placeholder.Local")).toBe(true);
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
