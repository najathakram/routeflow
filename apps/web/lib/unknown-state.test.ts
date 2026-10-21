import { headerLine, TRUNCATED_LINE } from "./unknown-state";

/** Row 510: there is no staff-orders switch; staff sales are always checked (warned, overridable with a reason). */
const TAIL =
  "They can still order — products with a legal state ban stay hidden from them in your portal and can't be ordered there. Staff (except drivers) are warned and can override with a reason.";

describe("headerLine (row 510)", () => {
  it("says staff are warned, never that staff orders are not checked", () => {
    const line = headerLine(5, false);
    expect(line).toBe(`5 customers need a state. ${TAIL}`);
    expect(line).not.toMatch(/aren't checked/);
  });

  it("singular keeps its grammar", () => {
    expect(headerLine(1, false)).toBe(`1 customer needs a state. ${TAIL}`);
  });

  it("truncated: the partial-count sentence", () => {
    expect(headerLine(5, true)).toBe(TRUNCATED_LINE);
  });

  it("all clear", () => {
    expect(headerLine(0, false)).toBe("Every customer has a state on file.");
  });
});
