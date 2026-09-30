import { isInternalEmail } from "./internal-email";

describe("isInternalEmail", () => {
  it("flags the CSV-import sentinel domain", () => {
    expect(isInternalEmail("acme_store@imported.local")).toBe(true);
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

  // B910 (Opus r2 follow-up): a recipient is not always a bare addr-spec. Every
  // form a caller can realistically hand a transport must hit the guard.
  describe("B910 — recipient forms beyond a bare addr-spec", () => {
    it.each([
      ["  acme_store@imported.local  ", "padded"],
      ["Acme Store <acme_store@imported.local>", "display-name"],
      ["<no-email+x@placeholder.local>", "bare angle-addr"],
      ["Acme Store <ACME_STORE@IMPORTED.LOCAL>", "display-name, mixed case"],
      ["acme_store@imported.local", "bare"],
      ["No-Email+X@PLACEHOLDER.LOCAL", "mixed case"],
    ])("flags %s (%s)", (form) => {
      expect(isInternalEmail(form)).toBe(true);
    });

    it("a display-name wrapping a REAL address stays unflagged", () => {
      expect(isInternalEmail("Acme Store <owner@acme.example>")).toBe(false);
      expect(isInternalEmail("  owner@acme.example  ")).toBe(false);
    });
  });
});
