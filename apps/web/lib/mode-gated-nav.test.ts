import { promotionsOn } from "@routeflow/types";
import { MODE_GATED_NAV, modeGatedVisible } from "./plan-gated-nav";

// SA-070 / SA-1032 rule 3: the nav gate reads a mode through the shared predicate, never its own
// "off". Undefined → the real helper; a test sets a value to prove the gate obeys the helper.
const mockPromotionsOn = jest.fn<boolean | undefined, [string | null | undefined]>();
jest.mock("@routeflow/types", () => {
  const actual = jest.requireActual("@routeflow/types");
  return {
    ...actual,
    promotionsOn: (mode?: string | null) => mockPromotionsOn(mode) ?? actual.promotionsOn(mode),
  };
});

// SA-1032: a business that turns promotions off loses the Promotions entry in the sidebar and
// the command palette. No config (modes unset) behaves as today: the entry shows.
describe("modeGatedVisible — promotions", () => {
  it("W-R1: hides /promotions when the promotions mode is off", () => {
    expect(MODE_GATED_NAV["/promotions"]).toBeDefined();
    expect(modeGatedVisible("/promotions", { promotions: "off" })).toBe(false);
  });

  it("shows /promotions when the mode is on, unset, or modes have not loaded", () => {
    expect(modeGatedVisible("/promotions", { promotions: "on" })).toBe(true);
    expect(modeGatedVisible("/promotions", { promotions: "unset" })).toBe(true);
    expect(modeGatedVisible("/promotions", {})).toBe(true);
    expect(modeGatedVisible("/promotions", null)).toBe(true);
    expect(modeGatedVisible("/promotions", undefined)).toBe(true);
  });

  it("never hides a route it does not gate", () => {
    expect(modeGatedVisible("/orders", { promotions: "off" })).toBe(true);
  });

  it("SA-1032 rule 3: /promotions is gated by the shared promotionsOn", () => {
    expect(MODE_GATED_NAV["/promotions"]).toEqual(["promotions", promotionsOn]);
    mockPromotionsOn.mockReturnValue(false);
    try {
      expect(modeGatedVisible("/promotions", { promotions: "on" })).toBe(false);
      expect(mockPromotionsOn).toHaveBeenCalledWith("on");
    } finally {
      mockPromotionsOn.mockReset();
    }
  });
});
