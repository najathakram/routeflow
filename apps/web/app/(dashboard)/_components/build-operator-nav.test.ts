import { buildOperatorNav, type OperatorNavContext } from "./build-operator-nav";
import {
  BadgePercent,
  BarChart2,
  BarChart3,
  Building2,
  ClipboardList,
  CreditCard,
  DollarSign,
  FileCheck,
  FileSpreadsheet,
  FileText,
  Handshake,
  Layers,
  LayoutDashboard,
  MapPin,
  Megaphone,
  Package,
  PackageCheck,
  Receipt,
  RotateCcw,
  ScanSearch,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Truck,
  Users,
  Wallet,
} from "lucide-react";
import type { NavEntry } from "./nav-config";

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
  // undefined flags = nothing gated off (full plan); [] = a LITE plan with no flags.
  plan: { flags: undefined, resolved: true, failed: false },
  modes: undefined,
  ...over,
});

/** "Label" for a leaf, "Group > a, b" for a group, "~key" for a skeleton. */
const shape = (nav: NavEntry[]): string[] =>
  nav.map((e) =>
    e.kind === "leaf"
      ? e.label
      : e.kind === "group"
        ? `${e.label} > ${e.children.map((c) => c.label).join(", ")}`
        : `~${e.key}`,
  );

const hrefs = (nav: NavEntry[]): string[] =>
  nav
    .flatMap((e) =>
      e.kind === "group" ? e.children.map((c) => c.href) : "href" in e ? [e.href] : [],
    )
    .sort();

const group = (nav: NavEntry[], label: string) => {
  const g = nav.find((e) => e.kind === "group" && e.label === label);
  return g && g.kind === "group" ? g : undefined;
};

describe("buildOperatorNav", () => {
  it("full operator", () => {
    expect(shape(buildOperatorNav(ctx()))).toEqual(SHAPE_FULL);
  });

  it("LITE operator (no plan flags) drops the gated leaves and any group left empty", () => {
    const nav = buildOperatorNav(ctx({ plan: { flags: [], resolved: true, failed: false } }));
    expect(shape(nav)).toEqual(SHAPE_LITE);
  });

  it("no Dispatch addons: the Dispatch group is gone", () => {
    const nav = buildOperatorNav(ctx({ routesAccess: false, deliveryAccess: false }));
    expect(group(nav, "Dispatch")).toBeUndefined();
  });

  it("canActAsDriver adds My Routes to Dispatch", () => {
    const nav = buildOperatorNav(ctx({ canActAsDriver: true }));
    expect(group(nav, "Dispatch")?.children.map((c) => c.label)).toEqual([
      "Dispatch",
      "Routes",
      "Order delivery",
      "Shipments",
      "Drivers",
      "My Routes",
    ]);
  });

  it("sales agents on: Sales agents after Customers, Commissions in Finance", () => {
    const nav = buildOperatorNav(ctx({ hasSalesAgents: true }));
    const labels = shape(nav);
    expect(labels[labels.indexOf("Customers") + 1]).toBe("Sales agents");
    expect(hrefs(nav)).toContain("/finance/commissions");
    expect(hrefs(nav)).toContain("/sales-agents");
  });

  it("counter on: Counter is the first child of Orders", () => {
    const nav = buildOperatorNav(ctx({ counterEnabled: true }));
    expect(group(nav, "Orders")?.children[0]).toMatchObject({
      label: "Counter",
      href: "/orders/counter-sale",
    });
  });

  it("regulated sections: a Regulated items group right after the Analytics area", () => {
    const nav = buildOperatorNav(ctx({ regulatedSections: [{ id: "s1", name: "Alpha" }] }));
    const labels = shape(nav);
    expect(labels[labels.indexOf("Regulated items > Alpha") - 1]).toBe(ANALYTICS_ENTRY);
    expect(hrefs(nav)).toContain("/compliance/s1");
  });

  it("addons loading: skeletons hold Dispatch and Sales agents places", () => {
    const nav = buildOperatorNav(
      ctx({ addonsLoading: true, routesAccess: false, deliveryAccess: false }),
    );
    const labels = shape(nav);
    expect(labels).toContain("~dispatch-skeleton");
    expect(labels).toContain("~sales-agents-skeleton");
    expect(labels.indexOf("~dispatch-skeleton")).toBe(labels.indexOf("Customers") - 1);
  });

  it("Estimates is in Orders and Finance has five children", () => {
    const nav = buildOperatorNav(ctx());
    expect(group(nav, "Orders")?.children.map((c) => c.label)).toContain("Estimates");
    expect(group(nav, "Finance")?.children.map((c) => c.label)).toEqual([
      "Finance overview",
      "Invoices",
      "Payments",
      "Payment requests",
      "Credit notes",
    ]);
  });

  it("no Dispatch access: Shipments is the last child of Orders", () => {
    const nav = buildOperatorNav(ctx({ routesAccess: false, deliveryAccess: false }));
    const orders = group(nav, "Orders")?.children.map((c) => c.label);
    expect(orders?.[orders.length - 1]).toBe("Shipments");
    expect(hrefs(nav)).toContain("/shipments");
  });

  it("Commissions ends the Finance group", () => {
    const nav = buildOperatorNav(ctx({ hasSalesAgents: true }));
    const fin = group(nav, "Finance")?.children.map((c) => c.label) ?? [];
    expect(fin[fin.length - 1]).toBe("Commissions");
  });

  it("LITE: no Reports & analytics entry and Supplier statements sits under Warehouse", () => {
    const nav = buildOperatorNav(ctx({ plan: { flags: [], resolved: true, failed: false } }));
    expect(group(nav, "Reports & analytics")).toBeUndefined();
    expect(group(nav, "Warehouse")?.children.map((c) => c.label)).toContain("Supplier statements");
  });

  it("customer and driver menus come from their own lists", () => {
    expect(shape(buildOperatorNav(ctx({ role: "CUSTOMER" })))).toEqual([
      "Dashboard",
      "Orders > My Orders, Returns",
      "Invoices",
      "My account",
    ]);
    expect(
      buildOperatorNav(ctx({ role: "DRIVER" })).map((e) => ("label" in e ? e.label : "")),
    ).toEqual(["Today's route", "My Routes", "My account"]);
  });

  it("every href of the full operator menu keeps exactly one place", () => {
    const all = hrefs(buildOperatorNav(ctx({ hasSalesAgents: true, counterEnabled: true })));
    expect(new Set(all).size).toBe(all.length);
    expect(all).toEqual([...ALL_HREFS].sort());
  });
});

const ANALYTICS_ENTRY = "Reports & analytics > Reports, Analytics";

// UX guide improvement 3: pages MOVE to the group people look in; no label or href changes.
const SHAPE_FULL = [
  "Dashboard",
  "Orders > All Orders, Estimates, Returns",
  "Dispatch > Dispatch, Routes, Order delivery, Shipments, Drivers",
  "Customers",
  "Warehouse > Inventory, Purchase orders, Products, Promotions, Suppliers, Supplier bills, Supplier statements",
  "Finance > Finance overview, Invoices, Payments, Payment requests, Credit notes",
  "Reports & analytics > Reports, Analytics",
  "Settings",
];

const SHAPE_LITE = [
  "Dashboard",
  "Orders > All Orders",
  "Dispatch > Dispatch, Routes, Order delivery, Shipments, Drivers",
  "Customers",
  "Warehouse > Inventory, Purchase orders, Products, Promotions, Supplier statements",
  "Finance > Finance overview, Invoices, Payments, Payment requests",
  "Settings",
];

const ALL_HREFS = [
  "/dashboard",
  "/orders/counter-sale",
  "/orders",
  "/returns",
  "/dispatch",
  "/routes",
  "/deliveries",
  "/drivers",
  "/customers",
  "/sales-agents",
  "/inventory",
  "/purchase-orders",
  "/products",
  "/promotions",
  "/suppliers",
  "/vendor-bills",
  "/finance/dashboard",
  "/invoices",
  "/shipments",
  "/estimates",
  "/credit-notes",
  "/finance/payments",
  "/finance/payment-requests",
  "/finance/statements",
  "/finance/reports",
  "/finance/commissions",
  "/analytics",
  "/settings",
];

// ─── Widened pin (expected values read from master's inline layout code, not from the builder) ───

const children = (nav: NavEntry[], label: string) =>
  group(nav, label)?.children.map((c) => c.label);
const lastEntry = (nav: NavEntry[]) => shape(nav)[nav.length - 1];

describe("buildOperatorNav: add-ons, modes, plan states (master's gating rules)", () => {
  it("routes add-on only: Dispatch has Dispatch, Routes and Drivers, no Order delivery", () => {
    const nav = buildOperatorNav(ctx({ routesAccess: true, deliveryAccess: false }));
    expect(children(nav, "Dispatch")).toEqual(["Dispatch", "Routes", "Shipments", "Drivers"]);
  });

  it("delivery add-on only: Dispatch has Dispatch, Order delivery and Drivers, no Routes", () => {
    const nav = buildOperatorNav(ctx({ routesAccess: false, deliveryAccess: true }));
    expect(children(nav, "Dispatch")).toEqual([
      "Dispatch",
      "Order delivery",
      "Shipments",
      "Drivers",
    ]);
  });

  it("modes: promotions off hides Promotions; any other value keeps it", () => {
    const off = buildOperatorNav(ctx({ modes: { promotions: "off" } }));
    expect(children(off, "Warehouse")).not.toContain("Promotions");
    for (const mode of ["on", "unset"]) {
      const nav = buildOperatorNav(ctx({ modes: { promotions: mode } }));
      expect(children(nav, "Warehouse")).toContain("Promotions");
    }
  });

  it("plan still loading hides every plan-gated leaf (and the group they leave empty)", () => {
    const nav = buildOperatorNav(
      ctx({ plan: { flags: undefined, resolved: false, failed: false } }),
    );
    expect(shape(nav)).toEqual(SHAPE_LITE);
  });

  it("plan fetch failed shows every plan-gated leaf (fails open)", () => {
    const nav = buildOperatorNav(
      ctx({ plan: { flags: undefined, resolved: false, failed: true } }),
    );
    expect(shape(nav)).toEqual(SHAPE_FULL);
  });

  it("regulated still loading: a skeleton follows Reports & analytics", () => {
    const nav = buildOperatorNav(ctx({ regulatedLoading: true }));
    const labels = shape(nav);
    expect(labels[labels.indexOf(ANALYTICS_ENTRY) + 1]).toBe("~regulated-skeleton");
  });

  it("Regulated items on LITE sits after Settings, as on master", () => {
    const nav = buildOperatorNav(
      ctx({
        plan: { flags: [], resolved: true, failed: false },
        regulatedSections: [{ id: "s1", name: "Alpha" }],
      }),
    );
    expect(lastEntry(nav)).toBe("Regulated items > Alpha");
    expect(shape(nav)[nav.length - 2]).toBe("Settings");
  });

  it("regulated loading on LITE puts the skeleton last", () => {
    const nav = buildOperatorNav(
      ctx({ plan: { flags: [], resolved: true, failed: false }, regulatedLoading: true }),
    );
    expect(lastEntry(nav)).toBe("~regulated-skeleton");
  });

  it("sales agents on LITE: Sales agents after Customers, Commissions ends Finance", () => {
    const nav = buildOperatorNav(
      ctx({ plan: { flags: [], resolved: true, failed: false }, hasSalesAgents: true }),
    );
    const labels = shape(nav);
    expect(labels[labels.indexOf("Customers") + 1]).toBe("Sales agents");
    const fin = children(nav, "Finance") ?? [];
    expect(fin[fin.length - 1]).toBe("Commissions");
  });
});

describe("buildOperatorNav: every entry keeps its icon (master's nav-config and splices)", () => {
  const ICON = new Map<string, unknown>([
    ["Dashboard", LayoutDashboard],
    ["Orders", ShoppingCart],
    ["Counter", Store],
    ["All Orders", ShoppingCart],
    ["Estimates", FileCheck],
    ["Returns", RotateCcw],
    ["Dispatch", Truck],
    ["Finance overview", LayoutDashboard],
    ["Routes", MapPin],
    ["Order delivery", Package],
    ["Shipments", Truck],
    ["Drivers", Truck],
    ["My Routes", MapPin],
    ["Customers", Users],
    ["Sales agents", Handshake],
    ["Warehouse", Package],
    ["Inventory", Layers],
    ["Purchase orders", PackageCheck],
    ["Products", Package],
    ["Promotions", Megaphone],
    ["Suppliers", Building2],
    ["Supplier bills", ClipboardList],
    ["Supplier statements", FileSpreadsheet],
    ["Finance", Wallet],
    ["Invoices", FileText],
    ["Payments", CreditCard],
    ["Payment requests", DollarSign],
    ["Credit notes", Receipt],
    ["Commissions", BadgePercent],
    ["Reports & analytics", BarChart3],
    ["Reports", BarChart3],
    ["Analytics", BarChart2],
    ["Settings", Settings],
    ["Regulated items", ShieldCheck],
    ["Alpha", ShieldCheck],
  ]);

  it("each group and leaf carries the icon it has on master", () => {
    const nav = buildOperatorNav(
      ctx({
        canActAsDriver: true,
        counterEnabled: true,
        hasSalesAgents: true,
        regulatedSections: [{ id: "s1", name: "Alpha" }],
      }),
    );
    const seen: Array<[string, unknown]> = [];
    for (const e of nav) {
      if (e.kind === "skeleton") continue;
      seen.push([e.label, e.icon]);
      if (e.kind === "group") for (const c of e.children) seen.push([c.label, c.icon]);
    }
    // "Dispatch" names both the group (Truck) and its first leaf (LayoutDashboard), so that label has two icons.
    for (const [label, icon] of seen) {
      const ok =
        label === "Dispatch"
          ? icon === Truck || icon === LayoutDashboard
          : icon === ICON.get(label);
      expect([label, ok]).toEqual([label, true]);
    }
    expect(seen.map(([l]) => l)).toEqual(expect.arrayContaining([...ICON.keys()]));
  });
});

describe("buildOperatorNav: Shipments waits for the add-ons answer (recorded behaviour, pinned)", () => {
  const holders = (nav: NavEntry[]) =>
    nav.flatMap((e) =>
      e.kind === "group" && e.children.some((c) => c.href === "/shipments") ? [e.label] : [],
    );

  it("while add-ons load (both access hooks still false), no group holds /shipments", () => {
    const nav = buildOperatorNav(
      ctx({ addonsLoading: true, routesAccess: false, deliveryAccess: false }),
    );
    expect(holders(nav)).toEqual([]);
  });

  it("once resolved, exactly one group holds it: Dispatch with access, Orders without", () => {
    expect(holders(buildOperatorNav(ctx()))).toEqual(["Dispatch"]);
    expect(holders(buildOperatorNav(ctx({ routesAccess: false, deliveryAccess: false })))).toEqual([
      "Orders",
    ]);
  });
});

describe("Product insights in Reports & analytics (UXG-R8 T11, SA-1087 as amended)", () => {
  const reports = (nav: NavEntry[]) => {
    const g = nav.find((e) => e.kind === "group" && e.label === "Reports & analytics");
    return g && g.kind === "group" ? g.children.map((c) => c.label) : null;
  };

  it("ends the group when the viewer may use insights and the plan has analytics", () => {
    const nav = buildOperatorNav(ctx({ insightsAccess: true }));
    expect(reports(nav)).toEqual(["Reports", "Analytics", "Product insights"]);
    const leaf = nav
      .flatMap((e) => (e.kind === "group" ? e.children : []))
      .find((c) => c.href === "/insights");
    expect(leaf?.icon).toBe(ScanSearch);
  });

  it("is absent without insights access (REPORTS denied, super admin, no role)", () => {
    expect(reports(buildOperatorNav(ctx({ insightsAccess: false })))).toEqual([
      "Reports",
      "Analytics",
    ]);
  });

  it("is absent when the plan has no analytics, even with access", () => {
    const nav = buildOperatorNav(
      ctx({
        insightsAccess: true,
        plan: { flags: ["flag.reports"], resolved: true, failed: false },
      }),
    );
    expect(reports(nav)).toEqual(["Reports"]);
  });

  it("is never in a customer or driver menu", () => {
    for (const role of ["CUSTOMER", "DRIVER"])
      expect(hrefs(buildOperatorNav(ctx({ role, insightsAccess: true })))).not.toContain(
        "/insights",
      );
  });
});
