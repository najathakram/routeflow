/**
 * The persistent operator nav lives outside the (tabs) navigator, so its active
 * item is derived from route segments rather than from navigator state. Every
 * operator route must resolve to exactly one of the five tabs — a bar with
 * nothing lit reads as broken to the operator.
 */
import {
  activeOperatorTab,
  visibleOperatorTabs,
  OPERATOR_TABS,
  OPERATOR_TAB_ROOT,
  type OperatorTabKey,
} from "../lib/operator-tabs";

describe("activeOperatorTab — routes inside (tabs)", () => {
  it("lights the tab you are on", () => {
    expect(activeOperatorTab(["(operator)", "(tabs)", "home"])).toBe("home");
    expect(activeOperatorTab(["(operator)", "(tabs)", "dispatch"])).toBe("dispatch");
    expect(activeOperatorTab(["(operator)", "(tabs)", "orders"])).toBe("orders");
    expect(activeOperatorTab(["(operator)", "(tabs)", "warehouse"])).toBe("warehouse");
    expect(activeOperatorTab(["(operator)", "(tabs)", "more"])).toBe("more");
  });

  it("keeps Orders lit one level into the tab's stack", () => {
    expect(activeOperatorTab(["(operator)", "(tabs)", "orders", "[id]"])).toBe("orders");
  });

  it("keeps Orders lit at the deepest nested route", () => {
    // The case the segment walk exists for: /(operator)/(tabs)/orders/[id]/edit-items
    expect(activeOperatorTab(["(operator)", "(tabs)", "orders", "[id]", "edit-items"])).toBe(
      "orders",
    );
  });

  it("sends the href:null finance route to More, where it is launched from", () => {
    expect(activeOperatorTab(["(operator)", "(tabs)", "finance"])).toBe("more");
  });

  it("sends the undeclared invoices tree to More, at any depth", () => {
    expect(activeOperatorTab(["(operator)", "(tabs)", "invoices"])).toBe("more");
    expect(activeOperatorTab(["(operator)", "(tabs)", "invoices", "[id]", "record-payment"])).toBe(
      "more",
    );
  });
});

describe("activeOperatorTab — routes outside (tabs)", () => {
  it("maps a section to its owning tab", () => {
    expect(activeOperatorTab(["(operator)", "new-order"])).toBe("orders");
    expect(activeOperatorTab(["(operator)", "products"])).toBe("warehouse");
    expect(activeOperatorTab(["(operator)", "movements"])).toBe("warehouse");
    expect(activeOperatorTab(["(operator)", "routes"])).toBe("dispatch");
    expect(activeOperatorTab(["(operator)", "drivers"])).toBe("dispatch");
  });

  it("stays on the owning tab however deep the route goes", () => {
    expect(activeOperatorTab(["(operator)", "products", "[id]", "edit"])).toBe("warehouse");
    expect(activeOperatorTab(["(operator)", "routes", "[id]", "map"])).toBe("dispatch");
  });

  it("falls back to More for a section reached from the More hub", () => {
    expect(activeOperatorTab(["(operator)", "credit-notes"])).toBe("more");
    expect(activeOperatorTab(["(operator)", "payments"])).toBe("more");
    expect(activeOperatorTab(["(operator)", "vendor-bills", "scan"])).toBe("more");
  });

  it("keeps the fallback stable with depth", () => {
    expect(activeOperatorTab(["(operator)", "credit-notes", "[id]"])).toBe("more");
  });
});

describe("activeOperatorTab — ad-hoc trips section", () => {
  it("maps the trips section to Dispatch (an unmapped section produces a dead tab bar)", () => {
    expect(activeOperatorTab(["(operator)", "trips"])).toBe("dispatch");
  });

  it("stays on Dispatch however deep the trips route goes", () => {
    expect(activeOperatorTab(["(operator)", "trips", "new"])).toBe("dispatch");
    expect(activeOperatorTab(["(operator)", "trips", "index"])).toBe("dispatch");
  });
});

describe("activeOperatorTab — degenerate input", () => {
  it("treats the bare group as Home", () => {
    expect(activeOperatorTab(["(operator)"])).toBe("home");
  });

  it("does not throw off-group or pre-mount", () => {
    expect(activeOperatorTab(["(driver)", "route"])).toBe("more");
    expect(activeOperatorTab([])).toBe("more");
  });

  it("tolerates an extra route group between (operator) and the section", () => {
    // Guards the "first non-group segment" walk against someone adding a group.
    expect(activeOperatorTab(["(operator)", "(tabs)", "(inner)", "orders"])).toBe("orders");
  });
});

describe("table invariants", () => {
  it("declares a root href for every tab, pointing inside (tabs)", () => {
    for (const tab of OPERATOR_TABS) {
      const href = OPERATOR_TAB_ROOT[tab];
      expect(`${tab}:${href}`).toBe(`${tab}:/(operator)/(tabs)/${tab}`);
    }
  });

  it("has no root href for a tab that is not in the bar", () => {
    const declared = Object.keys(OPERATOR_TAB_ROOT) as OperatorTabKey[];
    expect(declared.sort()).toEqual([...OPERATOR_TABS].sort());
  });

  it("resolves each tab root back to itself", () => {
    // Catches a tab being added to the bar without a SECTION_TO_TAB entry.
    for (const tab of OPERATOR_TABS) {
      expect(activeOperatorTab(["(operator)", "(tabs)", tab])).toBe(tab);
    }
  });
});

describe("visibleOperatorTabs — dispatch access gate", () => {
  it("returns every tab, including Dispatch, when either feature grants access", () => {
    expect(visibleOperatorTabs(true)).toEqual([...OPERATOR_TABS]);
    expect(visibleOperatorTabs(true)).toContain("dispatch");
  });

  it("drops only Dispatch when neither feature grants access, preserving order", () => {
    expect(visibleOperatorTabs(false)).toEqual(["home", "orders", "warehouse", "more"]);
    expect(visibleOperatorTabs(false)).not.toContain("dispatch");
  });
});
