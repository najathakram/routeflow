/**
 * Locks the CHECK payment lifecycle badge decision table so it never drifts from the mobile
 * mirror (apps/mobile/lib/check-badge.ts, tested in apps/mobile/__tests__/check-badge.test.ts).
 */
import { checkBadgeFor, paymentRowBadge } from "./check-badge";

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

// B1151: every buyer payment row reads a status, never an empty cell; credits are never cash words.
describe("paymentRowBadge", () => {
  it("keeps the check lifecycle badge when there is one", () => {
    expect(paymentRowBadge({ method: "CHECK", status: "PAID", checkStatus: "CLEARED" })).toEqual({
      label: "Cleared",
      variant: "success",
    });
  });

  it("maps a non-check row by its status", () => {
    expect(paymentRowBadge({ method: "CASH", status: "PAID" })).toEqual({
      label: "Received",
      variant: "success",
    });
    expect(paymentRowBadge({ method: "CASH", status: "VOID" })).toEqual({
      label: "Void",
      variant: "danger",
    });
    expect(paymentRowBadge({ method: "CASH", status: "DRAFT" })).toEqual({
      label: "Not confirmed",
      variant: "neutral",
    });
    expect(paymentRowBadge({ method: "ZELLE", status: "PENDING" })).toEqual({
      label: "Pending",
      variant: "warning",
    });
  });

  it("a credit note or advance application reads Applied, never Received", () => {
    expect(paymentRowBadge({ method: "CREDIT_NOTE", status: "PAID" })?.label).toBe("Applied");
    expect(paymentRowBadge({ method: "ADVANCE", status: "PAID" })?.label).toBe("Applied");
  });

  it("a voided check with no lifecycle status reads Void; an unknown status reads nothing", () => {
    expect(paymentRowBadge({ method: "CHECK", status: "VOID" })?.label).toBe("Void");
    expect(paymentRowBadge({ method: "CASH", status: "WEIRD" })).toBeNull();
  });
});
