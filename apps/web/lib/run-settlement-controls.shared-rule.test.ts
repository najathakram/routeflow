import { driverRunFooter, officeSettlementControls } from "./run-settlement-controls";

/**
 * Review-b on #4188 (ask 1): the footer must call the one shared rule, not re-derive it. `shouldForceSettlement` is
 * stubbed here to disagree with the money on the run; the controls must follow the stub. (SE-13 only looks for local
 * definitions of those names, so a footer that re-derives the rule slips past it.)
 */
const mockForce = jest.fn();
jest.mock("@routeflow/pricing", () => ({
  ...jest.requireActual("@routeflow/pricing"),
  shouldForceSettlement: (...a: unknown[]) => mockForce(...a),
}));

const RUN = {
  status: "IN_PROGRESS",
  stops: [{ id: "a", status: "COMPLETED" }],
  collectedPayments: { cashTotal: 60, checkTotal: 0, count: 1 },
  settlementNote: null,
} as never;

describe("controls follow pricing's shouldForceSettlement", () => {
  it("driver footer: the rule says settle, SETTLE; the rule says no, FINISH", () => {
    mockForce.mockReturnValue(true);
    expect(driverRunFooter(RUN)).toBe("SETTLE");
    mockForce.mockReturnValue(false);
    expect(driverRunFooter(RUN)).toBe("FINISH");
  });

  it("office card: the rule says settle, Settle run; the rule says no, Finish run", () => {
    mockForce.mockReturnValue(true);
    expect(officeSettlementControls(RUN, true)).toMatchObject({ settle: true, finish: false });
    mockForce.mockReturnValue(false);
    expect(officeSettlementControls(RUN, true)).toMatchObject({ settle: false, finish: true });
  });
});
