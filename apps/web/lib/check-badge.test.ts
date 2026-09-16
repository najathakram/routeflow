/**
 * Locks the CHECK payment lifecycle badge decision table so it never drifts from the mobile
 * mirror (apps/mobile/lib/check-badge.ts, tested in apps/mobile/__tests__/check-badge.test.ts).
 */
import { checkBadgeFor } from "./check-badge";

describe("checkBadgeFor", () => {
  it("returns null for non-CHECK payment methods", () => {
    expect(checkBadgeFor({ method: "CREDIT_CARD" })).toBeNull();
    expect(checkBadgeFor({ method: "CASH", checkStatus: "CLEARED" })).toBeNull();
  });

  it("maps each lifecycle status to its label + variant", () => {
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "RECORDED" })).toEqual({
      label: "Recorded",
      variant: "neutral",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "DEPOSITED" })).toEqual({
      label: "Deposited",
      variant: "info",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "CLEARED" })).toEqual({
      label: "Cleared",
      variant: "success",
    });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: "BOUNCED" })).toEqual({
      label: "Bounced",
      variant: "danger",
    });
  });

  it("keeps the Bounced badge even when status is also VOID", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "VOID", checkStatus: "BOUNCED" })).toEqual({
      label: "Bounced",
      variant: "danger",
    });
  });

  it("treats a missing checkStatus on legacy data as Recorded", () => {
    expect(checkBadgeFor({ method: "CHECK" })).toEqual({ label: "Recorded", variant: "neutral" });
    expect(checkBadgeFor({ method: "CHECK", checkStatus: null })).toEqual({
      label: "Recorded",
      variant: "neutral",
    });
  });

  it("returns null for a manually-voided check that never had a lifecycle (no checkStatus + VOID)", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "VOID" })).toBeNull();
    expect(checkBadgeFor({ method: "CHECK", status: "VOID", checkStatus: null })).toBeNull();
  });

  // Post-dated check payments PR-1
  it("REG-PR1-BADGE: maps a PENDING payment to 'Post-dated · pending' / warning, ahead of the checkStatus switch", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "PENDING", checkStatus: "RECORDED" })).toEqual({
      label: "Post-dated · pending",
      variant: "warning",
    });
  });

  it("REG-PR1-BADGE: the PENDING check wins even with no checkStatus at all", () => {
    expect(checkBadgeFor({ method: "CHECK", status: "PENDING" })).toEqual({
      label: "Post-dated · pending",
      variant: "warning",
    });
  });
});
