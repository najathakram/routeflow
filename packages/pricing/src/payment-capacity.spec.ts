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
  const paid = (amount: number) => ({ amount, status: "PAID", overpay: "REFUSE" });
  const draft = (amount: number) => ({ amount, status: "DRAFT", overpay: "REFUSE" });

  it("null when the amount fits, and for a write that consumes nothing (VOID)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(60)],
        amount: 40,
        status: "PAID",
        overpay: "REFUSE",
      }),
    ).toBeNull();
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(100)],
        amount: 5,
        status: "VOID",
        overpay: "REFUSE",
      }),
    ).toBeNull();
  });
  it("FULLY_PAID when confirmed money already covers the total (a DRAFT write too: R1)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(100)],
        amount: 5,
        status: "DRAFT",
        overpay: "REFUSE",
      }),
    ).toEqual({ kind: "FULLY_PAID", remaining: 0, message: "Invoice is already fully paid" });
  });
  it("RESERVED_BY_UNCONFIRMED when unconfirmed rows hold the rest (R4's copy)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(60), draft(40)],
        amount: 5,
        status: "PAID",
        overpay: "REFUSE",
      }),
    ).toEqual({
      kind: "RESERVED_BY_UNCONFIRMED",
      remaining: 0,
      message: "Invoice's remaining balance is already reserved by unconfirmed payments",
    });
  });
  it("EXCEEDS above the remaining capacity, a DRAFT write included (R2)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(60)],
        amount: 50,
        status: "DRAFT",
        overpay: "REFUSE",
      }),
    ).toEqual({
      kind: "EXCEEDS",
      remaining: 40,
      message: "Payment exceeds remaining balance of 40.00",
    });
  });
  it("CAPACITY_EPSILON is the writers' half-cent-free tolerance: 0.001 over still fits", () => {
    expect(CAPACITY_EPSILON).toBe(0.001);
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(60)],
        amount: 40.001,
        status: "PAID",
        overpay: "REFUSE",
      }),
    ).toBeNull();
    expect(
      capacityRefusal({
        total: 100,
        existing: [paid(60)],
        amount: 40.01,
        status: "PAID",
        overpay: "REFUSE",
      })?.kind,
    ).toBe("EXCEEDS");
  });
  it("a PENDING row reserves its share (SA-858 ruling 5: capacity counts PENDING)", () => {
    expect(
      capacityRefusal({
        total: 100,
        existing: [{ amount: 100, status: "PENDING" }],
        amount: 1,
        status: "PAID",
        overpay: "REFUSE",
      })?.kind,
    ).toBe("RESERVED_BY_UNCONFIRMED");
  });
});

describe("capacityRefusal overpay policy (SA-863)", () => {
  const paid = (amount: number) => ({ amount, status: "PAID" });
  const draft = (amount: number) => ({ amount, status: "DRAFT" });
  const allow = (existing: Array<{ amount: number; status: string }>, amount: number) =>
    capacityRefusal({
      total: 100,
      existing,
      amount,
      status: "PAID",
      overpay: "ALLOW_IF_NO_UNCONFIRMED",
    });

  it("[L-O2] with no unconfirmed rows a deliberate over-allocation is allowed (the p3 case: 105 on 100)", () => {
    expect(allow([], 105)).toBeNull();
    expect(allow([paid(100)], 5)).toBeNull(); // already fully paid: still the operator's deliberate choice
  });
  it("with a DRAFT or PENDING row, above capacity is RESERVED_BY_UNCONFIRMED (R3)", () => {
    expect(allow([draft(90)], 30)).toEqual({
      kind: "RESERVED_BY_UNCONFIRMED",
      remaining: 10,
      message: "Invoice's remaining balance is already reserved by unconfirmed payments",
    });
    expect(allow([{ amount: 90, status: "PENDING" }], 30)?.kind).toBe("RESERVED_BY_UNCONFIRMED");
  });
  it("within capacity while a DRAFT is present is allowed (R3c)", () => {
    expect(allow([draft(90)], 10)).toBeNull();
    expect(allow([draft(90)], 10.001)).toBeNull(); // CAPACITY_EPSILON
  });
  it("a VOID row never counts as unconfirmed", () => {
    expect(allow([{ amount: 90, status: "VOID" }], 105)).toBeNull();
  });
  it("R3d: the policy is REQUIRED (no default): omitting it does not compile", () => {
    // @ts-expect-error overpay is required (SA-863 rule 3)
    const r = capacityRefusal({ total: 100, existing: [], amount: 1, status: "PAID" });
    expect(r).toBeNull();
  });
});
