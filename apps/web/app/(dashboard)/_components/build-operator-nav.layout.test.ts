import * as fs from "fs";
import * as path from "path";
import { NAV_GROUP_ID_VALUES, type NavLayout } from "@routeflow/types";
import {
  buildOperatorNav,
  buildOperatorNavIndex,
  type OperatorNavContext,
} from "./build-operator-nav";
import type { NavEntry, NavGroup } from "./nav-config";
import { activeNavGroup, navLeaves } from "./nav-index";

/** SA-1209 F-1 + SA-1228 F-2: the layout pass (pinned, hidden, order) at the one exported exit of the sidebar. */
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

/** Every leaf href, counted raw (never through navLeaves, which de-duplicates). */
const rawLeaves = (nav: NavEntry[]): string[] =>
  nav.flatMap((e) =>
    e.kind === "leaf" ? [e.href] : e.kind === "group" ? e.children.map((c) => c.href) : [],
  );
const sortIds = (nav: NavEntry[]): string[] =>
  nav.map((e) => (e.kind === "leaf" ? e.href : e.kind === "group" ? e.id : (e.holds ?? e.key)));
const full = (over: Partial<OperatorNavContext> = {}) =>
  ctx({
    counterEnabled: true,
    hasSalesAgents: true,
    insightsAccess: true,
    regulatedSections: [{ id: "s1", name: "Alpha" }],
    ...over,
  });

describe("buildOperatorNav with a stored navLayout", () => {
  it("with no layout (loading or failed) the sidebar is exactly the default", () => {
    const base = buildOperatorNav(ctx());
    expect(buildOperatorNav(ctx({ navLayout: undefined }))).toEqual(base);
    expect(pinnedGroup(base)).toBeUndefined();
  });

  it("an empty layout changes nothing", () => {
    expect(buildOperatorNav(ctx({ navLayout: layout([]) }))).toEqual(buildOperatorNav(ctx()));
  });

  it("a pinned /invoices shows in a top Pinned section and Finance does not list it", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/invoices"]) }));
    expect(nav[0]).toMatchObject({ kind: "group", label: "Pinned" });
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/invoices"]);
    expect(hrefsIn(group(nav, "Finance"))).not.toContain("/invoices");
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

  it("a pinned Regulated Items leaf (injected) shows in Pinned and its emptied group is gone", () => {
    const nav = buildOperatorNav(
      ctx({
        regulatedSections: [{ id: "s1", name: "Alpha" }],
        navLayout: layout(["/compliance/s1"]),
      }),
    );
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/compliance/s1"]);
    expect(group(nav, "Regulated items")).toBeUndefined();
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

  it("a malformed layout from a bad client changes nothing and never throws", () => {
    const base = buildOperatorNav(ctx());
    for (const bad of ["junk", [1, 2], null]) {
      expect(buildOperatorNav(ctx({ navLayout: bad as unknown as NavLayout }))).toEqual(base);
    }
  });

  it("a pinned page is listed once: navLeaves has it once and no other group holds it", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/invoices"]) }));
    expect(navLeaves(nav).filter((l) => l.href === "/invoices")).toHaveLength(1);
    expect(activeNavGroup(nav, "/invoices")).toBeNull();
  });

  it("customers and drivers get their own menus untouched by a layout", () => {
    for (const role of ["CUSTOMER", "DRIVER"]) {
      const base = buildOperatorNav(ctx({ role }));
      expect(buildOperatorNav(ctx({ role, navLayout: layout(["/invoices"]) }))).toEqual(base);
    }
  });
});

describe("F-2: hidden and order are applied (SA-1228)", () => {
  it("R1 hidden /orders drops the leaf; the Orders group keeps Estimates and Returns", () => {
    const nav = buildOperatorNav(ctx({ navLayout: layout([], { hidden: ["/orders"] }) }));
    expect(rawLeaves(nav)).not.toContain("/orders");
    expect(hrefsIn(group(nav, "Orders"))).toEqual(["/estimates", "/returns"]);
  });

  it("R2 hiding every Orders child drops the group; Counter keeps it when the counter is on", () => {
    const hidden = ["/orders", "/estimates", "/returns"];
    const off = buildOperatorNav(ctx({ navLayout: layout([], { hidden }) }));
    expect(off.some((e) => e.kind === "group" && e.id === "orders")).toBe(false);
    const on = buildOperatorNav(ctx({ counterEnabled: true, navLayout: layout([], { hidden }) }));
    expect(hrefsIn(group(on, "Orders"))).toEqual(["/orders/counter-sale"]);
  });

  it("R3 order puts named top-level entries first and keeps the rest in default order", () => {
    const nav = buildOperatorNav(
      ctx({ navLayout: layout([], { order: ["finance", "/customers"] }) }),
    );
    expect(sortIds(nav)).toEqual([
      "finance",
      "/customers",
      "/dashboard",
      "orders",
      "dispatch",
      "warehouse",
      "reports",
      "/settings",
    ]);
  });

  it("R4 a pinned Invoices is listed once and a hidden Orders is gone", () => {
    const nav = buildOperatorNav(
      ctx({ navLayout: layout(["/invoices"], { hidden: ["/orders"] }) }),
    );
    expect(rawLeaves(nav).filter((h) => h === "/invoices")).toHaveLength(1);
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/invoices"]);
    expect(hrefsIn(group(nav, "Finance"))).not.toContain("/invoices");
    expect(rawLeaves(nav)).not.toContain("/orders");
  });

  it("R5 a pinned leaf leaves its place: an emptied group is gone, a top-level leaf is not repeated", () => {
    const reg = buildOperatorNav(
      ctx({
        regulatedSections: [{ id: "s1", name: "Alpha" }],
        navLayout: layout(["/compliance/s1"]),
      }),
    );
    expect(group(reg, "Regulated items")).toBeUndefined();
    const nav = buildOperatorNav(ctx({ navLayout: layout(["/customers"]) }));
    expect(nav.some((e) => e.kind === "leaf" && e.href === "/customers")).toBe(false);
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/customers"]);
  });

  it("R6 stale ids are ignored: the result equals order [finance] alone", () => {
    const stale = buildOperatorNav(
      ctx({
        navLayout: {
          order: ["nope", "Finance", "pinned", "finance", "finance"],
          hidden: ["/not-a-page"],
          pinned: ["/gone"],
        },
      }),
    );
    expect(stale).toEqual(buildOperatorNav(ctx({ navLayout: layout([], { order: ["finance"] }) })));
    expect(pinnedGroup(stale)).toBeUndefined();
  });

  it("R7 a skeleton holds the place of the entry it stands for: the rail does not jump", () => {
    const l = layout([], { order: ["dispatch"] });
    const loading = buildOperatorNav(
      ctx({ addonsLoading: true, routesAccess: false, deliveryAccess: false, navLayout: l }),
    );
    expect(loading[0]).toMatchObject({ kind: "skeleton", key: "dispatch-skeleton" });
    const loaded = buildOperatorNav(ctx({ navLayout: l }));
    expect(loaded[0]).toMatchObject({ kind: "group", id: "dispatch" });
  });

  it("R8 every group has a unique id from NAV_GROUP_ID_VALUES and every id is used", () => {
    const ids = buildOperatorNav(full()).flatMap((e) => (e.kind === "group" ? [e.id] : []));
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual([...NAV_GROUP_ID_VALUES].sort());
  });

  it("G1 Settings can never be hidden", () => {
    const nav = buildOperatorNav(
      ctx({ navLayout: layout([], { hidden: ["/settings", "/customers"] }) }),
    );
    expect(rawLeaves(nav)).toContain("/settings");
    expect(rawLeaves(nav)).not.toContain("/customers");
  });

  it("G2 an empty layout and no layout both equal today's menu", () => {
    const base = buildOperatorNav(full());
    expect(buildOperatorNav(full({ navLayout: layout([]) }))).toEqual(base);
    expect(buildOperatorNav(full({ navLayout: undefined }))).toEqual(base);
  });

  it("G3 the layout only drops or moves: every leaf equals one of the base menu's", () => {
    const base = buildOperatorNav(full());
    const baseLeaves = new Map(
      base
        .flatMap((e) => (e.kind === "leaf" ? [e] : e.kind === "group" ? e.children : []))
        .map((l) => [l.href, l]),
    );
    const layouts = [
      layout([], { hidden: ["/orders"] }),
      layout([], { hidden: ["/orders", "/estimates", "/returns", "/orders/counter-sale"] }),
      layout([], { order: ["finance", "/customers"] }),
      layout(["/invoices"], { hidden: ["/orders"] }),
      layout(["/compliance/s1", "/customers"]),
    ];
    for (const l of layouts) {
      const nav = buildOperatorNav(full({ navLayout: l }));
      expect(rawLeaves(nav).length).toBeLessThanOrEqual(baseLeaves.size);
      for (const e of nav)
        for (const leaf of e.kind === "leaf" ? [e] : e.kind === "group" ? e.children : [])
          expect(leaf).toEqual(baseLeaves.get(leaf.href));
    }
  });

  it("G4 display only: no guard reads the layout, and the palette index keeps a hidden page", () => {
    const root = path.resolve(__dirname, "../../..");
    for (const f of [
      "app/(dashboard)/_components/gates/RouteGuard.tsx",
      "app/(dashboard)/_components/gates/PlanGateBoundary.tsx",
      "middleware.ts",
    ]) {
      expect(fs.readFileSync(path.join(root, f), "utf8")).not.toMatch(/navLayout|nav-layout/);
    }
    const idx = buildOperatorNavIndex(
      ctx({ navLayout: layout(["/invoices"], { hidden: ["/orders"] }) }),
    );
    expect(navLeaves(idx).map((l) => l.href)).toContain("/orders");
  });

  it("G5 customers and drivers are unchanged by the R4 layout", () => {
    const l = layout(["/invoices"], { hidden: ["/orders"], order: ["finance"] });
    for (const role of ["CUSTOMER", "DRIVER"]) {
      expect(buildOperatorNav(ctx({ role, navLayout: l }))).toEqual(
        buildOperatorNav(ctx({ role })),
      );
    }
  });

  it("G6 malformed lists are read one by one: a good pin still applies and nothing throws", () => {
    const bad = { pinned: ["/invoices"], order: "x", hidden: null } as unknown as NavLayout;
    const nav = buildOperatorNav(ctx({ navLayout: bad }));
    expect(hrefsIn(pinnedGroup(nav))).toEqual(["/invoices"]);
  });
});
