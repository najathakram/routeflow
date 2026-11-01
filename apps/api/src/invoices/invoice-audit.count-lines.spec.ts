import { countLinesChanged } from "./invoice-audit";

/** SA-1048 A3: two subtotals are the same figure when roundMoney makes them equal (F-3), not when a hand cents round does. */
describe("countLinesChanged compares subtotals by roundMoney equality", () => {
  const line = (subtotal: number) => [{ orderItemId: "oi-1", qty: 1, subtotal }];

  it("1.005 and 1.01 are the same figure: not a changed line", () => {
    expect(countLinesChanged(line(1.005), line(1.01))).toBe(0);
  });

  it("1.00 and 1.01 differ by a cent: one changed line", () => {
    expect(countLinesChanged(line(1), line(1.01))).toBe(1);
  });

  it("an added and a removed line each count as one", () => {
    expect(countLinesChanged([], line(5))).toBe(1);
    expect(countLinesChanged(line(5), [])).toBe(1);
  });
});
