import {
  OVERSELL_COPY,
  canEditOversell,
  nextOversellMode,
  oversellIsOn,
} from "../lib/oversell-settings";

/**
 * Settings → Ordering (mobile mirror of web's out-of-stock card): only the exact mode "backorder"
 * is ON, the toggle sends the opposite mode, only a TENANT_ADMIN edits, and toasts are fixed copy.
 */
describe("oversellIsOn", () => {
  it('is on only for exactly "backorder"', () => {
    expect(oversellIsOn("backorder")).toBe(true);
    expect(oversellIsOn("off")).toBe(false);
  });

  it.each(["", "BACKORDER", "on", "true", "allow", null, undefined, 1, true])(
    "an unknown stored value (%j) is off, never on",
    (v) => {
      expect(oversellIsOn(v)).toBe(false);
    },
  );
});

describe("nextOversellMode", () => {
  it("turning on sends backorder; turning off sends off", () => {
    expect(nextOversellMode(false)).toBe("backorder");
    expect(nextOversellMode(true)).toBe("off");
  });

  it("round-trips through oversellIsOn", () => {
    expect(oversellIsOn(nextOversellMode(false))).toBe(true);
    expect(oversellIsOn(nextOversellMode(true))).toBe(false);
  });
});

describe("canEditOversell", () => {
  it("only a TENANT_ADMIN edits", () => {
    expect(canEditOversell("TENANT_ADMIN")).toBe(true);
  });

  it.each(["OPERATOR", "DRIVER", "CUSTOMER", "tenant_admin", "", null, undefined])(
    "%j reads only",
    (role) => {
      expect(canEditOversell(role)).toBe(false);
    },
  );
});

describe("OVERSELL_COPY", () => {
  it("says what the switch does and that staff can always oversell", () => {
    expect(OVERSELL_COPY.hint).toMatch(/below zero/);
    expect(OVERSELL_COPY.hint).toMatch(/backorder/);
    expect(OVERSELL_COPY.hint).toMatch(/Staff can always/);
  });

  it("matches the web card: the same section title and the same save-failed copy", () => {
    expect(OVERSELL_COPY.section).toBe("Out-of-stock ordering");
    expect(OVERSELL_COPY.saveFailed).toBe("Couldn't save the out-of-stock ordering setting");
    expect(OVERSELL_COPY.label).toBe("Let customers order items that are out of stock");
  });

  it("the toasts are fixed strings (no server text channel)", () => {
    for (const k of ["loadFailed", "saveFailed", "savedOn", "savedOff"] as const) {
      expect(typeof OVERSELL_COPY[k]).toBe("string");
    }
  });
});
