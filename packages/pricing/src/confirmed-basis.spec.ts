import {
  capacityRefusal,
  unconfirmedNoLongerFitting,
  type CapacityOverpayPolicy,
} from "./payment-confirmation";

/**
 * W-769 (owner 7b = A, SA-910 Part 2 as SA-922 corrects it): real money is never turned away by an unconfirmed row.
 *  - A PAID write takes CONFIRMED_BASIS: refused only when CONFIRMED money already covers the total (FULLY_PAID) or the
 *    amount exceeds total − confirmed (EXCEEDS). Never RESERVED_BY_UNCONFIRMED.
 *  - CONFIRMED_BASIS_ALLOW_OVERPAY is [L-O2]'s office deliberate overpay, with or without unconfirmed rows.
 *  - An unconfirmed (DRAFT / PENDING) write keeps REFUSE on capacity (#3645), whatever the policy.
 *  - `unconfirmedNoLongerFitting(total, rows)` is the ONE predicate behind the flag: the unconfirmed rows beyond what the
 *    confirmed money leaves, newest first.
 * Master: the two policies and the predicate do not exist (the spec does not compile), the RED.
 */
const paid = (amount: number, id = `p${amount}`, at = 1) => ({
  id,
  amount,
  status: "PAID",
  createdAt: new Date(at),
});
const draft = (amount: number, id = `d${amount}`, at = 2) => ({
  id,
  amount,
  status: "DRAFT",
  createdAt: new Date(at),
});
const refusal = (
  existing: Array<{ amount: number; status: string }>,
  amount: number,
  overpay: CapacityOverpayPolicy,
  status = "PAID",
) => capacityRefusal({ total: 100, existing, amount, status, overpay });

describe("capacityRefusal: CONFIRMED_BASIS for real money (W-769, SA-910 Part 2)", () => {
  it("P1 a DRAFT reserving the whole invoice never turns PAID money away", () => {
    expect(refusal([draft(100)], 100, "CONFIRMED_BASIS")).toBeNull();
  });

  it("P2 confirmed money already covers the total: FULLY_PAID", () => {
    expect(refusal([paid(100), draft(50)], 1, "CONFIRMED_BASIS")?.kind).toBe("FULLY_PAID");
  });

  it("P3 the amount beyond total − CONFIRMED: EXCEEDS with remaining 40 (not capacity's 0)", () => {
    expect(refusal([paid(60), draft(40)], 50, "CONFIRMED_BASIS")).toEqual({
      kind: "EXCEEDS",
      remaining: 40,
      message: "Payment exceeds remaining balance of 40.00",
    });
    expect(refusal([paid(60), draft(40)], 40, "CONFIRMED_BASIS")).toBeNull();
  });

  it("P4 CONFIRMED_BASIS_ALLOW_OVERPAY ([L-O2]): an office overpay over a DRAFT records (its advance books the rest)", () => {
    expect(refusal([draft(100)], 150, "CONFIRMED_BASIS_ALLOW_OVERPAY")).toBeNull();
    expect(refusal([], 150, "CONFIRMED_BASIS_ALLOW_OVERPAY")).toBeNull();
  });

  it("P5 an unconfirmed write keeps REFUSE on capacity under every policy (#3645)", () => {
    for (const overpay of ["CONFIRMED_BASIS", "CONFIRMED_BASIS_ALLOW_OVERPAY"] as const) {
      expect(refusal([draft(100)], 1, overpay, "DRAFT")?.kind).toBe("RESERVED_BY_UNCONFIRMED");
      expect(refusal([draft(100)], 1, overpay, "PENDING")?.kind).toBe("RESERVED_BY_UNCONFIRMED");
    }
  });

  it("P5b REFUSE itself is unchanged (the DRAFT writers and stored value stay on capacity)", () => {
    expect(refusal([draft(100)], 1, "REFUSE")?.kind).toBe("RESERVED_BY_UNCONFIRMED");
    expect(refusal([paid(60), draft(40)], 1, "REFUSE")?.kind).toBe("RESERVED_BY_UNCONFIRMED");
  });

  it("P8 the policy is a closed union with no default: every member is listed here, and omitting it does not compile", () => {
    const all: Record<CapacityOverpayPolicy, true> = {
      REFUSE: true,
      CONFIRMED_BASIS: true,
      CONFIRMED_BASIS_ALLOW_OVERPAY: true,
    };
    expect(Object.keys(all).sort()).toEqual([
      "CONFIRMED_BASIS",
      "CONFIRMED_BASIS_ALLOW_OVERPAY",
      "REFUSE",
    ]);
    // @ts-expect-error `overpay` is required: the compiler lists every writer
    capacityRefusal({ total: 100, existing: [], amount: 1, status: "PAID" });
  });
});

describe("unconfirmedNoLongerFitting: the ONE no-longer-fits predicate (W-769)", () => {
  it("P6 confirmed 70 leaves room 30: the older DRAFT 20 fits, the newer DRAFT 20 does not", () => {
    expect(
      unconfirmedNoLongerFitting(100, [paid(70, "p", 1), draft(20, "t2", 2), draft(20, "t3", 3)]),
    ).toEqual(["t3"]);
  });

  it("P6c three DRAFT 0.10 on a 0.30 total all fit (the running room is rounded, no float residue)", () => {
    expect(
      unconfirmedNoLongerFitting(0.3, [draft(0.1, "a", 1), draft(0.1, "b", 2), draft(0.1, "c", 3)]),
    ).toEqual([]);
  });

  it("P7 confirmed money covers the total: every unconfirmed row, newest first; a VOID row never", () => {
    expect(
      unconfirmedNoLongerFitting(100, [
        paid(100, "p", 1),
        draft(20, "d", 2),
        { id: "pend", amount: 10, status: "PENDING", createdAt: new Date(3) },
        { id: "v", amount: 50, status: "VOID", createdAt: new Date(4) },
      ]),
    ).toEqual(["pend", "d"]);
  });

  it("P6b nothing confirmed and the DRAFTs fit: an empty set (no over-flagging)", () => {
    expect(unconfirmedNoLongerFitting(100, [draft(30, "a", 1), draft(70, "b", 2)])).toEqual([]);
    expect(unconfirmedNoLongerFitting(100, [])).toEqual([]);
  });
});
