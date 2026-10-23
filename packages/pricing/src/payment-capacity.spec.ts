import { PAYMENT_STATUS_VALUES } from "@routeflow/types";
import {
  CAPACITY_EPSILON,
  capacityRefusal,
  consumesCapacity,
  remainingCapacity,
} from "./payment-confirmation";

/**
 * Row 2299 / SA-858 ruling 1: ONE capacity predicate beside remainingCapacity. CAPACITY = every non-VOID row
 * (DRAFT + PAID + PENDING), the N4 rule; `capacityRefusal` carries recordPayment's three cases and copy.
 */
describe("consumesCapacity: a partition over every PaymentStatus (R6)", () => {
  const CONSUMES: Record<(typeof PAYMENT_STATUS_VALUES)[number], boolean> = {
    DRAFT: true,
    PAID: true,
    PENDING: true,
    VOID: false,
  };
  it("names every PaymentStatus exactly once (a fifth status fails here until it is classified)", () => {
    expect([...PAYMENT_STATUS_VALUES].sort()).toEqual(Object.keys(CONSUMES).sort());
  });
  it.each(Object.entries(CONSUMES))("%s consumes capacity: %s", (status, consumes) => {
    expect(consumesCapacity(status)).toBe(consumes);
  });
  it("remainingCapacity sums exactly the rows consumesCapacity names", () => {
    const rows = PAYMENT_STATUS_VALUES.map((status) => ({ status, amount: 10 }));
    const consumed = rows.filter((r) => consumesCapacity(r.status)).length * 10;
    expect(remainingCapacity(100, rows)).toBe(100 - consumed);
  });
});

describe("capacityRefusal: recordPayment's three cases, one epsilon", () => {
  const paid = (amount: number) => ({ amount, status: "PAID" });
  const draft = (amount: number) => ({ amount, status: "DRAFT" });

  it("null when the amount fits, and for a write that consumes nothing (VOID)", () => {
    expect(
      capacityRefusal({ total: 100, existing: [paid(60)], amount: 40, status: "PAID" }),
    ).toBeNull();
    expect(
      capacityRefusal({ total: 100, existing: [paid(100)], amount: 5, status: "VOID" }),
    ).toBeNull();
  });
  it("FULLY_PAID when confirmed money already covers the total (a DRAFT write too: R1)", () => {
    expect(
      capacityRefusal({ total: 100, existing: [paid(100)], amount: 5, status: "DRAFT" }),
    ).toEqual({ kind: "FULLY_PAID", remaining: 0, message: "Invoice is already fully paid" });
  });
  it("RESERVED_BY_UNCONFIRMED when unconfirmed rows hold the rest (R4's copy)", () => {
    expect(
      capacityRefusal({ total: 100, existing: [paid(60), draft(40)], amount: 5, status: "PAID" }),
    ).toEqual({
      kind: "RESERVED_BY_UNCONFIRMED",
      remaining: 0,
      message: "Invoice's remaining balance is already reserved by unconfirmed payments",
    });
  });
  it("EXCEEDS above the remaining capacity, a DRAFT write included (R2)", () => {
    expect(
      capacityRefusal({ total: 100, existing: [paid(60)], amount: 50, status: "DRAFT" }),
    ).toEqual({
      kind: "EXCEEDS",
      remaining: 40,
      message: "Payment exceeds remaining balance of 40.00",
    });
  });
  it("CAPACITY_EPSILON is the writers' half-cent-free tolerance: 0.001 over still fits", () => {
    expect(CAPACITY_EPSILON).toBe(0.001);
    expect(
      capacityRefusal({ total: 100, existing: [paid(60)], amount: 40.001, status: "PAID" }),
    ).toBeNull();
    expect(
      capacityRefusal({ total: 100, existing: [paid(60)], amount: 40.01, status: "PAID" })?.kind,
    ).toBe("EXCEEDS");
  });
  it("a PENDING row reserves its share (SA-858 ruling 5: capacity counts PENDING)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [{ amount: 100, status: "PENDING" }],
        amount: 1,
        status: "PAID",
      })?.kind,
    ).toBe("RESERVED_BY_UNCONFIRMED");
  });
});
