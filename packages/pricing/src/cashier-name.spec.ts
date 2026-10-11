import { cashierNameOf } from "./cashier-name";

/**
 * Row 317 (review fold): the ONE display name of a staff user on a customer-facing receipt (Cashier / Reprinted by), shared
 * by the API (Today's row, reprint, e-mail) and the web (live receipt, reprint). It is the user's `username`, never an email.
 */
describe("cashierNameOf", () => {
  it("is the trimmed username", () => {
    expect(cashierNameOf({ username: "  jane  " })).toBe("jane");
  });

  it("is null for an old row (no soldBy), a missing or blank username", () => {
    expect(cashierNameOf(null)).toBeNull();
    expect(cashierNameOf(undefined)).toBeNull();
    expect(cashierNameOf({ username: null })).toBeNull();
    expect(cashierNameOf({ username: "   " })).toBeNull();
  });

  it("never prints an email: an email-shaped username reads as no cashier", () => {
    expect(cashierNameOf({ username: "jane@acme.test" })).toBeNull();
  });
});
