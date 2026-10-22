import { clearedTenderNow } from "./cleared-tender";

describe("clearedTenderNow (what is paid at the till, for the credit gate)", () => {
  it("counts CASH and CARD amounts", () => {
    expect(clearedTenderNow([{ method: "CASH", amount: 50 }], 50)).toBe(50);
    expect(clearedTenderNow([{ method: "CARD", amount: 50 }], 50)).toBe(50);
  });

  it("a partial payment counts exactly what was paid", () => {
    expect(clearedTenderNow([{ method: "CASH", amount: 20 }], 50)).toBe(20);
  });

  it("is capped at the total: cash with change never goes over (the remainder is never negative)", () => {
    expect(clearedTenderNow([{ method: "CASH", amount: 100 }], 50)).toBe(50);
    expect(roundRemainder(50, clearedTenderNow([{ method: "CASH", amount: 100 }], 50))).toBe(0);
  });

  it("a same-day CHECK (not flagged pending) counts like cash; a pending (post-dated) CHECK and ON_ACCOUNT count 0", () => {
    expect(clearedTenderNow([{ method: "CHECK", amount: 50 }], 50)).toBe(50);
    expect(clearedTenderNow([{ method: "CHECK" }], 50)).toBe(50);
    expect(clearedTenderNow([{ method: "CHECK", amount: 50, pending: false }], 50)).toBe(50);
    expect(clearedTenderNow([{ method: "CHECK", amount: 50, pending: true }], 50)).toBe(0);
    expect(clearedTenderNow([{ method: "ON_ACCOUNT" }], 50)).toBe(0);
    expect(clearedTenderNow([{ method: "ON_ACCOUNT", amount: 50 }], 50)).toBe(0);
  });

  it("an omitted amount on CASH/CARD is the rest of the balance", () => {
    expect(clearedTenderNow([{ method: "CASH" }], 50.25)).toBe(50.25);
    expect(clearedTenderNow([{ method: "CARD", amount: null }], 12.1)).toBe(12.1);
  });

  it("sums legs in whole cents (split tender slots in), and a pending check leg adds nothing", () => {
    expect(
      clearedTenderNow(
        [
          { method: "CARD", amount: 30.1 },
          { method: "CASH", amount: 10.2 },
          { method: "CHECK", amount: 5, pending: true },
        ],
        50,
      ),
    ).toBe(40.3);
    expect(
      clearedTenderNow(
        [
          { method: "CARD", amount: 30 },
          { method: "CASH", amount: 40 },
        ],
        50,
      ),
    ).toBe(50);
  });

  it("float noise does not move a cent", () => {
    expect(
      clearedTenderNow(
        [
          { method: "CASH", amount: 0.1 },
          { method: "CASH", amount: 0.2 },
        ],
        1,
      ),
    ).toBe(0.3);
  });

  it("zero, negative, NaN and Infinity amounts count 0; an empty request or a zero total is 0", () => {
    for (const amount of [0, -5, NaN, Infinity]) {
      expect(clearedTenderNow([{ method: "CASH", amount }], 50)).toBe(0);
    }
    expect(clearedTenderNow([], 50)).toBe(0);
    expect(clearedTenderNow([{ method: "CASH", amount: 10 }], 0)).toBe(0);
  });
});

function roundRemainder(total: number, paid: number): number {
  return Math.round((total - paid) * 100) / 100;
}
