/**
 * Wave-4 pure-logic guards for the operator customer-file Licenses screen —
 * lazy-expiry display status, the status→Pill map, the server-status-machine
 * action flags, expiry phrasing, and the capture/renew form rules.
 */
import {
  authSourceLabel,
  authStatusPill,
  authorizationActionFlags,
  displayAuthStatus,
  expiresInDays,
  expiryPhrase,
  validateLicenseForm,
} from "../lib/customer-authorizations-logic";

const NOW = new Date("2026-08-12T12:00:00Z");

describe("displayAuthStatus (lazy expiry)", () => {
  it("reads a VERIFIED row past its expiry as EXPIRED", () => {
    expect(displayAuthStatus({ status: "VERIFIED", expiresAt: "2026-08-01T00:00:00Z" }, NOW)).toBe(
      "EXPIRED",
    );
  });
  it("keeps a VERIFIED row with a future expiry", () => {
    expect(displayAuthStatus({ status: "VERIFIED", expiresAt: "2027-01-01T00:00:00Z" }, NOW)).toBe(
      "VERIFIED",
    );
  });
  it("keeps a VERIFIED row with no expiry (permanent license)", () => {
    expect(displayAuthStatus({ status: "VERIFIED", expiresAt: null }, NOW)).toBe("VERIFIED");
  });
  it("never rewrites non-VERIFIED statuses", () => {
    expect(
      displayAuthStatus({ status: "PENDING_REVIEW", expiresAt: "2026-08-01T00:00:00Z" }, NOW),
    ).toBe("PENDING_REVIEW");
  });
});

describe("authStatusPill", () => {
  it.each([
    ["VERIFIED", "green", "Verified"],
    ["PENDING_REVIEW", "orange", "Pending review"],
    ["EXPIRED", "red", "Expired"],
    ["REJECTED", "red", "Rejected"],
    ["NONE", "gray", "Not submitted"],
  ] as const)("%s → %s / %s", (status, variant, label) => {
    expect(authStatusPill(status)).toEqual({ variant, label });
  });
});

describe("authSourceLabel", () => {
  it("mirrors web's wording exactly", () => {
    expect(authSourceLabel("RETAILER_SUBMITTED")).toBe("Submitted by buyer");
    expect(authSourceLabel("WHOLESALER_ADDED")).toBe("Added by you");
  });
});

describe("authorizationActionFlags (server status machine)", () => {
  it("PENDING_REVIEW → approve + reject only", () => {
    expect(authorizationActionFlags("PENDING_REVIEW")).toEqual({
      canApprove: true,
      canReject: true,
      canRenew: false,
    });
  });
  it.each(["VERIFIED", "EXPIRED"] as const)("%s → renew only", (s) => {
    expect(authorizationActionFlags(s)).toEqual({
      canApprove: false,
      canReject: false,
      canRenew: true,
    });
  });
  it("REJECTED/NONE → no actions (buyer resubmits or operator adds fresh)", () => {
    expect(authorizationActionFlags("REJECTED")).toEqual({
      canApprove: false,
      canReject: false,
      canRenew: false,
    });
    expect(authorizationActionFlags("NONE")).toEqual({
      canApprove: false,
      canReject: false,
      canRenew: false,
    });
  });
});

describe("expiresInDays / expiryPhrase", () => {
  it("null expiry → null", () => {
    expect(expiresInDays(null, NOW)).toBeNull();
    expect(expiryPhrase(null, NOW)).toBeNull();
  });
  it("counts whole days forward (ceil)", () => {
    expect(expiresInDays("2026-08-19T12:00:00Z", NOW)).toBe(7);
    expect(expiryPhrase("2026-08-19T12:00:00Z", NOW)).toBe("Expires in 7 days");
  });
  it("singular day", () => {
    expect(expiryPhrase("2026-08-13T12:00:00Z", NOW)).toBe("Expires in 1 day");
  });
  it("beyond the 30-day window → dated phrase", () => {
    expect(expiryPhrase("2026-12-31T00:00:00Z", NOW)).toBe("Expires 2026-12-31");
  });
  it("already past → expired phrasing", () => {
    expect(expiryPhrase("2026-08-10T12:00:00Z", NOW)).toBe("Expired 2 days ago");
  });
});

describe("validateLicenseForm (mirrors web LicenseModal rules)", () => {
  it("accepts a number + future date", () => {
    expect(
      validateLicenseForm({ licenseNumber: "TX-123", expiresAt: "2027-01-01" }, NOW),
    ).toBeNull();
  });
  it.each([
    [{ licenseNumber: " ", expiresAt: "2027-01-01" }, /license number/],
    [{ licenseNumber: "TX-1", expiresAt: "01/01/2027" }, /YYYY-MM-DD/],
    [{ licenseNumber: "TX-1", expiresAt: "2026-01-01" }, /in the past/],
  ] as const)("rejects %j", (form, msg) => {
    expect(validateLicenseForm(form, NOW)).toMatch(msg);
  });
});
