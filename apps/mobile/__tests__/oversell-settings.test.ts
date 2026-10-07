import {
  OVERSELL_COPY,
  VISIBILITY_COPY,
  canEditOversell,
  canEditVisibility,
  nextOversellMode,
  oversellIsOn,
  visibilityMode,
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

describe("OOS PR2: what customers see about backordered items", () => {
  it('only the exact value "hide" hides; everything else reads as the default, show', () => {
    expect(visibilityMode("hide")).toBe("hide");
    for (const v of ["show", "HIDE", "Hide", "yes", "", null, undefined, 1, true]) {
      expect(visibilityMode(v)).toBe("show");
    }
  });

  it("only an admin, and only while out-of-stock ordering is ON, may change it", () => {
    expect(canEditVisibility("TENANT_ADMIN", true)).toBe(true);
    expect(canEditVisibility("TENANT_ADMIN", false)).toBe(false);
    for (const role of ["OPERATOR", "DRIVER", "CUSTOMER", null, undefined]) {
      expect(canEditVisibility(role, true)).toBe(false);
    }
  });

  it("matches the web card's copy (title, both choices, toasts)", () => {
    expect(VISIBILITY_COPY.title).toBe("What customers see about backordered items");
    expect(VISIBILITY_COPY.show).toBe(
      'Show it: the item says "Ships when restocked" and the order is tagged',
    );
    expect(VISIBILITY_COPY.hide).toBe(
      "Hide it: the item looks in stock and customers see nothing about backorders",
    );
    expect(VISIBILITY_COPY.needsSwitch).toBe(
      "This applies when out-of-stock ordering is on for a customer.",
    );
    expect(VISIBILITY_COPY.savedShow).toBe(
      "Customers will see that backordered items ship when restocked",
    );
    expect(VISIBILITY_COPY.savedHide).toBe(
      "Customers will no longer see anything about backorders",
    );
    expect(VISIBILITY_COPY.saveFailed).toBe(
      "Couldn't save what customers see about backordered items",
    );
  });
});
