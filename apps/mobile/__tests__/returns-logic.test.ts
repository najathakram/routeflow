/**
 * Returns action-flag gating must mirror the server's transition guards exactly,
 * so the mobile UI never offers a transition the server would 400.
 */
import { buildReturnItems, returnActionFlags, returnPillFor } from "../lib/returns-logic";

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

describe("buildReturnItems", () => {
  const lines = [
    { productId: "a", orderedQty: 10 },
    { productId: "b", orderedQty: 4 },
    { productId: null, orderedQty: 3 }, // unlisted — always skipped
  ];

  it("skips blank/zero/unlisted lines and keeps entered ones", () => {
    const out = buildReturnItems(lines, { a: "3" }, {});
    expect(out).toEqual([{ productId: "a", qty: 3, restock: true }]);
  });

  it("caps the return qty at the ordered qty", () => {
    const out = buildReturnItems(lines, { b: "99" }, {});
    expect(out).toEqual([{ productId: "b", qty: 4, restock: true }]);
  });

  it("carries the per-line restock choice (default true)", () => {
    const out = buildReturnItems(lines, { a: "1", b: "2" }, { a: false });
    expect(out).toEqual([
      { productId: "a", qty: 1, restock: false },
      { productId: "b", qty: 2, restock: true },
    ]);
  });

  it("ignores non-numeric / negative qty", () => {
    expect(buildReturnItems(lines, { a: "abc", b: "-2" }, {})).toEqual([]);
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
