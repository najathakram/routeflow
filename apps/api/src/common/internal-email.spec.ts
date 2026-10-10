import { isInternalEmail } from "./internal-email";
// Spec files are NOT compiled into dist, so a value-import of @routeflow/types is
// fine HERE (same precedent as backfill-product-catalog-rows.db.spec.ts) — it is
// what lets this spec pin the api's local copy to the shared implementation.
import { isInternalEmail as sharedIsInternalEmail } from "@routeflow/types";

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

  // B910 drift pin: the api keeps a LOCAL copy (runtime source must not
  // value-import @routeflow/types — the "API runtime imports" tripwire), so this
  // table pins it functionally equal to the shared implementation web and mobile
  // re-export. A divergence fails here before it can ship.
  describe("B910 — api copy stays equal to the @routeflow/types implementation", () => {
    it.each([
      "acme_store@imported.local",
      "no-email+123e4567@placeholder.local",
      "  acme_store@imported.local  ",
      "Acme Store <acme_store@imported.local>",
      "<no-email+x@placeholder.local>",
      "Acme Store <ACME_STORE@IMPORTED.LOCAL>",
      "SOMEONE@IMPORTED.LOCAL",
      "billing@acmeco.com",
      "owner@imported.localhost.com",
      "Acme Store <owner@acme.example>",
      "  owner@acme.example  ",
      "x@sub.imported.local", // a subdomain of the sentinel domain is NOT the sentinel
      "x@imported.local.", // trailing dot: not matched by either copy
      '"a b"@imported.local', // quoted local part
      "",
    ])("agrees with the shared implementation for %j", (form) => {
      expect(isInternalEmail(form)).toBe(sharedIsInternalEmail(form));
    });

    it("agrees for null/undefined", () => {
      expect(isInternalEmail(null)).toBe(sharedIsInternalEmail(null));
      expect(isInternalEmail(undefined)).toBe(sharedIsInternalEmail(undefined));
    });
  });
});
