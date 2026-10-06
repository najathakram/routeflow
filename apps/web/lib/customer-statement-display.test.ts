import { statementMoney, STATEMENT_UNAVAILABLE } from "./customer-statement-display";

const fmt = (n: number) => `$${n.toFixed(2)}`;
const loaded = { outstandingAmount: 125.5, advanceBalance: 0, overdueAmount: 0 };

describe("statementMoney (B1005): a balance is a real figure or an em dash, never a made-up $0.00", () => {
  it("is an em dash while the statement is loading", () => {
    expect(statementMoney<typeof loaded>(undefined, false, (s) => s.outstandingAmount, fmt)).toBe(
      "—",
    );
    expect(STATEMENT_UNAVAILABLE).toBe("—");
  });

  it("is an em dash when the statement request failed, even if stale data is present", () => {
    expect(statementMoney<typeof loaded>(undefined, true, (s) => s.outstandingAmount, fmt)).toBe(
      "—",
    );
    expect(statementMoney(loaded, true, (s) => s.outstandingAmount, fmt)).toBe("—");
  });

  it("formats a loaded figure, and a REAL zero is $0.00 (not an em dash)", () => {
    expect(statementMoney(loaded, false, (s) => s.outstandingAmount, fmt)).toBe("$125.50");
    expect(statementMoney(loaded, false, (s) => s.advanceBalance, fmt)).toBe("$0.00");
  });

  it("is an em dash when the field is absent or not a finite number (an older API)", () => {
    expect(statementMoney(loaded, false, () => undefined, fmt)).toBe("—");
    expect(statementMoney(loaded, false, () => null, fmt)).toBe("—");
    expect(statementMoney(loaded, false, () => Number.NaN, fmt)).toBe("—");
  });
});
