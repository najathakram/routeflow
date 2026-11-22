import type { NavLayout } from "@routeflow/types";
import { buildOperatorNav, type OperatorNavContext } from "./build-operator-nav";
import type { NavEntry, NavGroup } from "./nav-config";
import { activeNavGroup, navLeaves } from "./nav-index";

/** SA-1209 F-1: the layout pass at the one exported exit of the sidebar, PINNED ONLY. */
const ctx = (over: Partial<OperatorNavContext> = {}): OperatorNavContext => ({
  role: "OPERATOR",
  canActAsDriver: false,
  routesAccess: true,
  deliveryAccess: true,
  addonsLoading: false,
  hasSalesAgents: false,
  counterEnabled: false,
  regulatedLoading: false,
  regulatedSections: [],
  insightsAccess: false,
  plan: { flags: undefined, resolved: true, failed: false },
  modes: undefined,
  ...over,
});

const layout = (pinned: string[], extra: Partial<NavLayout> = {}): NavLayout => ({
  pinned,
  order: [],
  hidden: [],
  ...extra,
});

const pinnedGroup = (nav: NavEntry[]): NavGroup | undefined =>
  nav.find((e): e is NavGroup => e.kind === "group" && e.label === "Pinned");
const group = (nav: NavEntry[], label: string): NavGroup | undefined =>
  nav.find((e): e is NavGroup => e.kind === "group" && e.label === label);
const hrefsIn = (g: NavGroup | undefined) => g?.children.map((c) => c.href);

describe("buildOperatorNav with a stored navLayout (pinned only)", () => {
  it("with no layout (loading or failed) the sidebar is exactly the default", () => {
    const base = buildOperatorNav(ctx());
    expect(buildOperatorNav(ctx({ navLayout: undefined }))).toEqual(base);
    expect(pinnedGroup(base)).toBeUndefined();
  });

  it("an empty layout changes nothing", () => {
    expect(buildOperatorNav(ctx({ navLayout: layout([]) }))).toEqual(buildOperatorNav(ctx()));
  });

  it("a pinned /invoices shows in a top Pinned section and Finance still lists Invoices", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/invoices"]) }));
    expect(nav[0]).toMatchObject({ kind: "group", label: "Pinned" });
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/invoices"]);
    expect(hrefsIn(group(nav, "Finance"))).toContain("/invoices");
  });

  it("pins keep their stored order, collapse duplicates and stop at 5", () => {
    const pins = [
      "/customers",
      "/orders",
      "/invoices",
      "/orders",
      "/products",
      "/inventory",
      "/drivers",
    ];
    const nav = buildOperatorNav(ctx({ navLayout: layout(pins) }));
    expect(hrefsIn(pinnedGroup(nav))).toEqual([
      "/customers",
      "/orders",
      "/invoices",
      "/products",
      "/inventory",
    ]);
  });

  it("never adds an entry: a pinned href the viewer has no entry for is dropped, with no Pinned section", () => {
    const base = buildOperatorNav(ctx());
    const nav = buildOperatorNav(
      ctx({ navLayout: layout(["/not-a-page", "/orders/counter-sale"]) }),
    );
    // counter is off for this viewer, so /orders/counter-sale is not in their menu either
    expect(nav).toEqual(base);
  });

  it("a plan-gated leaf without the flag is not shown, pinned or in its group", () => {
    const lite = { flags: [] as string[], resolved: true, failed: false };
    const nav = buildOperatorNav(ctx({ plan: lite, navLayout: layout(["/returns", "/invoices"]) }));
    const all = navLeaves(nav).map((l) => l.href);
    expect(all.filter((h) => h === "/returns")).toEqual([]);
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/invoices"]);
  });

  it("a pinned Regulated Items leaf (injected) shows in Pinned for a tenant that has it", () => {
    const nav = buildOperatorNav(
      ctx({
        regulatedSections: [{ id: "s1", name: "Alpha" }],
        navLayout: layout(["/compliance/s1"]),
      }),
    );
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/compliance/s1"]);
    expect(hrefsIn(group(nav, "Regulated items"))).toEqual(["/compliance/s1"]);
  });

  it("a Regulated Items pin for a tenant without sections shows nothing", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/compliance/s1"]) }));
    expect(pinnedGroup(nav)).toBeUndefined();
  });

  it("a Counter pin shows only when the counter is on", () => {
    const off = buildOperatorNav(ctx({ navLayout: layout(["/orders/counter-sale"]) }));
    expect(pinnedGroup(off)).toBeUndefined();
    const on = buildOperatorNav(
      ctx({ counterEnabled: true, navLayout: layout(["/orders/counter-sale"]) }),
    );
    expect(hrefsIn(pinnedGroup(on))).toEqual(["/orders/counter-sale"]);
  });

  it("order and hidden are stored but not applied yet (F-2)", () => {
    const base = buildOperatorNav(ctx());
    const nav = buildOperatorNav(
      ctx({ navLayout: layout([], { order: ["Finance"], hidden: ["/customers", "/settings"] }) }),
    );
    expect(nav).toEqual(base);
  });

  it("a malformed layout from a bad client changes nothing and never throws", () => {
    const base = buildOperatorNav(ctx());
    for (const bad of ["junk", [1, 2], { pinned: "/invoices" }, null]) {
      expect(buildOperatorNav(ctx({ navLayout: bad as unknown as NavLayout }))).toEqual(base);
    }
  });

  it("a pinned page is one page to the palette and its own group opens, not the Pinned copy", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/invoices"]) }));
    expect(navLeaves(nav).filter((l) => l.href === "/invoices")).toHaveLength(1);
    expect(activeNavGroup(nav, "/invoices")?.label).toBe("Finance");
  });

  it("customers and drivers get their own menus untouched by a layout", () => {
    for (const role of ["CUSTOMER", "DRIVER"]) {
      const base = buildOperatorNav(ctx({ role }));
      expect(buildOperatorNav(ctx({ role, navLayout: layout(["/invoices"]) }))).toEqual(base);
    }
  });
});
