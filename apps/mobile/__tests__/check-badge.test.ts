/**
 * Locks the CHECK payment lifecycle decision table (mobile mirror of the web
 * P5-12 badge) so the mobile Pill variants never drift from the web ones.
 */
import { checkBadgeFor } from "../lib/check-badge";

describe("checkBadgeFor", () => {
  it("returns null for non-CHECK payment methods", () => {
    expect(checkBadgeFor({ method: "CREDIT_CARD" })).toBeNull();
    expect(checkBadgeFor({ method: "CASH", checkStatus: "CLEARED" })).toBeNull();
    expect(checkBadgeFor({ method: null })).toBeNull();
    expect(checkBadgeFor({})).toBeNull();
  });

  it("maps each lifecycle status to its label + variant", () => {
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "RECORDED" })).toEqual({
      label: "Recorded",
      variant: "gray",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "DEPOSITED" })).toEqual({
      label: "Deposited",
      variant: "brand",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "CLEARED" })).toEqual({
      label: "Cleared",
      variant: "green",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "BOUNCED" })).toEqual({
      label: "Bounced",
      variant: "red",
    });
  });

  it("keeps the Bounced badge even when status is also VOID", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "VOID", checkStatus: "BOUNCED" })).toEqual({
      label: "Bounced",
      variant: "red",
    });
  });

  it("treats a missing checkStatus on legacy data as Recorded", () => {
    expect(checkBadgeFor({ method: "CHECK" })).toEqual({ label: "Recorded", variant: "gray" });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: null })).toEqual({
      label: "Recorded",
      variant: "gray",
    });
  });

  it("returns null for a manually-voided check that never had a lifecycle (no checkStatus + VOID)", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "VOID" })).toBeNull();
    expect(checkBadgeFor({ method: "CHECK", status: "VOID", checkStatus: null })).toBeNull();
  });
});
