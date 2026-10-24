import { displayEmail, isInternalEmail, NO_EMAIL_COPY } from "./formatting";

/**
 * #2854 Opus fold — the four web render sites (customers list Email column,
 * pending-approvals "Buyer account" line, customer detail Email InfoRow +
 * buyer-account card, buyer portal account page) all route email rendering
 * through displayEmail (L-225 shared-helper shape). These cases pin the helper's
 * contract per site pattern, so a site can only regress by leaving the helper.
 */
describe("displayEmail — render-side sentinel gate", () => {
  it("passes a real address through unchanged", () => {
    expect(displayEmail("billing@acmeco.com")).toBe("billing@acmeco.com");
  });

  it.each(["acme_store@imported.local", "no-email+x@placeholder.local", "X@IMPORTED.LOCAL"])(
    "%s is null — identical to no email on file",
    (sentinel) => {
      expect(isInternalEmail(sentinel)).toBe(true);
      expect(displayEmail(sentinel)).toBeNull();
    },
  );

  it("absent values (null/undefined/empty) are null too", () => {
    expect(displayEmail(null)).toBeNull();
    expect(displayEmail(undefined)).toBeNull();
    expect(displayEmail("")).toBeNull();
  });

  it("a lookalike real domain is NOT filtered", () => {
    expect(displayEmail("owner@imported.localhost.com")).toBe("owner@imported.localhost.com");
  });

  it("list Email column pattern: Customer.email is gated BEFORE the user-email fallback (B3)", () => {
    // Sentinel Customer.email must fall through to the login email, not render raw.
    const sentinelCustomer = "acme_store@imported.local";
    const loginEmail = "owner@acme.example";
    expect(displayEmail(sentinelCustomer) ?? displayEmail(loginEmail) ?? NO_EMAIL_COPY).toBe(
      loginEmail,
    );
  });

  it("pending-approvals pattern: both sources sentinel → the fixed empty copy", () => {
    expect(
      displayEmail("a@imported.local") ??
        displayEmail("no-email+x@placeholder.local") ??
        NO_EMAIL_COPY,
    ).toBe(NO_EMAIL_COPY);
  });

  it("conditional-row pattern (detail InfoRow / buyer-account card / business email): sentinel hides the row", () => {
    expect(Boolean(displayEmail("no-email+x@placeholder.local"))).toBe(false);
    expect(Boolean(displayEmail("owner@acme.example"))).toBe(true);
  });

  it("the empty copy is the one fixed string", () => {
    expect(NO_EMAIL_COPY).toBe("No email");
  });
});
