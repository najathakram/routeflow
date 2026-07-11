/**
 * Returns action-flag gating must mirror the server's transition guards exactly,
 * so the mobile UI never offers a transition the server would 400.
 */
import { returnActionFlags, returnPillFor } from "../lib/returns-logic";

describe("returnActionFlags", () => {
  it("PENDING → approve + reject only", () => {
    const f = returnActionFlags("PENDING");
    expect(f).toMatchObject({
      canApprove: true,
      canReject: true,
      canMarkInTransit: false,
      canReceive: false,
      canRefund: false,
      terminal: false,
    });
  });

  it("APPROVED → in-transit only (never jumps straight to received)", () => {
    const f = returnActionFlags("APPROVED");
    expect(f.canMarkInTransit).toBe(true);
    expect(f.canReceive).toBe(false);
    expect(f.canApprove).toBe(false);
  });

  it("IN_TRANSIT → receive only", () => {
    const f = returnActionFlags("IN_TRANSIT");
    expect(f.canReceive).toBe(true);
    expect(f.canMarkInTransit).toBe(false);
  });

  it("RECEIVED → refund only", () => {
    const f = returnActionFlags("RECEIVED");
    expect(f.canRefund).toBe(true);
    expect(f.canReceive).toBe(false);
  });

  it("terminal statuses offer nothing", () => {
    for (const s of ["REFUNDED", "PROCESSED", "REJECTED", "CANCELLED"] as const) {
      const f = returnActionFlags(s);
      expect(f.terminal).toBe(true);
      expect(f.canApprove || f.canReject || f.canMarkInTransit || f.canReceive || f.canRefund).toBe(
        false,
      );
    }
  });
});

describe("returnPillFor", () => {
  it("maps every status to a labeled pill (no raw enum leaks)", () => {
    expect(returnPillFor("IN_TRANSIT").label).toBe("In transit");
    expect(returnPillFor("REJECTED").variant).toBe("red");
    expect(returnPillFor("REFUNDED").variant).toBe("green");
    // Unknown status degrades gracefully to gray + the raw string.
    expect(returnPillFor("WEIRD")).toEqual({ variant: "gray", label: "WEIRD" });
  });
});
