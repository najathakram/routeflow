import { buildOperatorNav, type OperatorNavContext } from "./build-operator-nav";
import { DRIVER_NAV, OPERATOR_NAV, type NavEntry } from "./nav-config";
import { activeNavLeaf, navLeaves, navShortcuts, navShortcutTargets } from "./nav-index";

const ctx = (over: Partial<OperatorNavContext> = {}): OperatorNavContext => ({
  role: "OPERATOR",
  canActAsDriver: true,
  routesAccess: true,
  deliveryAccess: true,
  addonsLoading: false,
  hasSalesAgents: false,
  counterEnabled: true,
  regulatedLoading: false,
  regulatedSections: [],
  insightsAccess: false,
  plan: { flags: undefined, resolved: true, failed: false },
  modes: undefined,
  ...over,
});

describe("activeNavLeaf: the one rule for which entry holds a page (UXG-R8 T1)", () => {
  const nav = buildOperatorNav(ctx());

  it("a path that only shares letters with a leaf holds no entry", () => {
    expect(activeNavLeaf(nav, "/ordersx")).toBeNull();
  });

  it("the longest leaf wins over its parent leaf", () => {
    expect(activeNavLeaf(nav, "/orders/counter-sale")?.label).toBe("Counter");
    expect(activeNavLeaf(nav, "/routes/my-runs")?.label).toBe("My Routes");
    expect(activeNavLeaf(nav, "/routes/abc")?.label).toBe("Routes");
  });

  it("looks across groups and top-level leaves alike", () => {
    expect(activeNavLeaf(nav, "/customers/c1")?.href).toBe("/customers");
    expect(activeNavLeaf(nav, "/invoices")?.href).toBe("/invoices");
  });

  it("skips skeleton rows", () => {
    const loading = buildOperatorNav(ctx({ addonsLoading: true }));
    expect(loading.some((e) => e.kind === "skeleton")).toBe(true);
    expect(navLeaves(loading).every((l) => l.kind === "leaf")).toBe(true);
  });
});

describe("navLeaves: every leaf in menu order", () => {
  it("flattens groups in order", () => {
    const hrefs = navLeaves(OPERATOR_NAV).map((l) => l.href);
    expect(hrefs.slice(0, 4)).toEqual(["/dashboard", "/orders", "/estimates", "/returns"]);
    expect(hrefs[hrefs.length - 1]).toBe("/settings");
  });
});

describe("navShortcuts: only the pages this person's menu holds (UXG-R8 T9)", () => {
  it("a driver gets g h, g r and g s only", () => {
    const nav = DRIVER_NAV as NavEntry[];
    expect(navShortcuts(nav).map((s) => s.keys.join(" "))).toEqual(["g h", "g r", "g s"]);
    expect(navShortcutTargets(nav)).toEqual({
      h: "/dashboard",
      r: "/routes",
      s: "/settings",
    });
  });

  it("each shortcut is labelled from its menu entry", () => {
    const nav = buildOperatorNav(ctx());
    const byKey = Object.fromEntries(navShortcuts(nav).map((s) => [s.keys[1], s.label]));
    expect(byKey.c).toBe("Go to Customers");
    expect(byKey.t).toBe("Go to Counter");
  });

  it("counter and routes letters follow the menu", () => {
    const none = buildOperatorNav(ctx({ counterEnabled: false, routesAccess: false }));
    const letters = Object.keys(navShortcutTargets(none));
    expect(letters).not.toContain("t");
    expect(letters).not.toContain("r");
    expect(letters).toContain("d"); // Drivers stays while Deliveries keeps Dispatch
  });
});
