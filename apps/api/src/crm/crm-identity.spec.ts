import { normalizeEmail, normalizePhoneE164, slugUsername } from "./crm-identity";

/**
 * TP1: identity helpers (T1-T5, spec R25). Pure functions, no Prisma/HTTP mocking needed.
 */
describe("crm-identity", () => {
  describe("normalizeEmail", () => {
    it("T1: trims whitespace and lower-cases", () => {
      expect(normalizeEmail(" Foo@Bar.COM ")).toBe("foo@bar.com");
    });

    it("T2: returns null when there is no @", () => {
      expect(normalizeEmail("nope")).toBeNull();
    });
  });

  describe("normalizePhoneE164", () => {
    it("T3: normalizes a national-format number to E.164 given a region", () => {
      expect(normalizePhoneE164("(416) 555-0134", "CA")).toBe("+14165550134");
    });

    it("T4: returns null (never throws) for a number too short to be valid", () => {
      expect(() => normalizePhoneE164("12", "CA")).not.toThrow();
      expect(normalizePhoneE164("12", "CA")).toBeNull();
    });
  });

  describe("slugUsername", () => {
    it("T5: lower-cases, replaces non-alphanumerics with underscore, trims to <=30 chars, pads short names with crm", () => {
      expect(slugUsername("Acme Foods & Co.")).toBe("acme_foods_co");
      expect(slugUsername("A")).toBe("a_crm");
    });
  });
});
