import { CUSTOMER_NAV, DRIVER_NAV, OPERATOR_NAV, defaultOpenGroup } from "./nav-config";
import { PLAN_GATED_NAV, matchPlanGatedRoute } from "@/lib/plan-gated-nav";

const warehouse = () => {
  const g = OPERATOR_NAV.find((e) => e.kind === "group" && e.label === "Warehouse");
  if (!g || g.kind !== "group") throw new Error("no Warehouse group");
  return g;
};
const hrefs = (nav: typeof OPERATOR_NAV) =>
  nav.flatMap((e) =>
    e.kind === "group" ? e.children.map((c) => c.href) : "href" in e ? [e.href] : [],
  );

describe("operator nav: Purchase Orders + Supplier Bills", () => {
  it("lists Purchase Orders directly under Inventory in Warehouse", () => {
    const labels = warehouse().children.map((c) => c.label);
    expect(labels.indexOf("Purchase Orders")).toBe(labels.indexOf("Inventory") + 1);
    const leaf = warehouse().children.find((c) => c.label === "Purchase Orders");
    expect(leaf?.href).toBe("/purchase-orders");
  });

  it("is not plan-gated, so LITE tenants keep it", () => {
    expect(matchPlanGatedRoute("/purchase-orders")).toBeNull();
    expect(Object.keys(PLAN_GATED_NAV)).not.toContain("/purchase-orders");
  });

  it("is never in the customer or driver nav", () => {
    expect(hrefs(CUSTOMER_NAV)).not.toContain("/purchase-orders");
    expect(hrefs(DRIVER_NAV)).not.toContain("/purchase-orders");
  });

  it("renames Bills & Purchasing to Supplier Bills with the same href", () => {
    const labels = warehouse().children.map((c) => c.label);
    expect(labels).not.toContain("Bills & Purchasing");
    const leaf = warehouse().children.find((c) => c.label === "Supplier Bills");
    expect(leaf?.href).toBe("/vendor-bills");
    expect(matchPlanGatedRoute("/vendor-bills")).toBe("flag.ap_bills");
  });

  it("opens Warehouse by default on a first load with no active group", () => {
    expect(defaultOpenGroup(OPERATOR_NAV, "/dashboard")).toBe("Warehouse");
  });

  it("keeps the active group over the default", () => {
    expect(defaultOpenGroup(OPERATOR_NAV, "/orders")).toBe("Orders");
    expect(defaultOpenGroup(OPERATOR_NAV, "/purchase-orders")).toBe("Warehouse");
  });

  it("has no default group when the nav has no Warehouse (customer)", () => {
    expect(defaultOpenGroup(CUSTOMER_NAV, "/dashboard")).toBeNull();
  });

  it("keeps Purchase Orders for a LITE tenant (no plan flags) and lists it once", () => {
    const all = hrefs(OPERATOR_NAV);
    expect(all.filter((h) => h === "/purchase-orders")).toHaveLength(1);
    // the leaf's own route never maps to a plan flag, so a flag-less plan keeps it
    expect(matchPlanGatedRoute("/purchase-orders")).toBeNull();
  });

  it("puts no Bills & Purchasing label anywhere in any role's nav", () => {
    const labels = [OPERATOR_NAV, CUSTOMER_NAV, DRIVER_NAV].flatMap((nav) =>
      nav.flatMap((e) =>
        e.kind === "group"
          ? [e.label, ...e.children.map((c) => c.label)]
          : "label" in e
            ? [e.label]
            : [],
      ),
    );
    expect(labels).not.toContain("Bills & Purchasing");
  });
});

// REG-B1013: a buyer or a driver has no business settings — their /settings entry is their own
// account page, so the sidebar must not advertise a "Settings" hub to them.
describe("customer and driver nav: settings entry is My account (REG-B1013)", () => {
  const leaf = (nav: typeof OPERATOR_NAV) =>
    nav.find((e) => e.kind === "leaf" && e.href === "/settings");
  it.each([
    ["customer", CUSTOMER_NAV],
    ["driver", DRIVER_NAV],
  ])("the %s nav labels it My account", (_role, nav) => {
    expect(leaf(nav)).toMatchObject({ label: "My account", href: "/settings" });
  });
  it("the operator nav keeps Settings", () => {
    expect(leaf(OPERATOR_NAV)).toMatchObject({ label: "Settings" });
  });
});
