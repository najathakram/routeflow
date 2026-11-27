import {
  PAGE_SURFACES,
  STAFF_CAPABILITY_VALUES,
  mayUse,
  routeAccess,
  staffMay,
  type SurfacePrincipal,
} from "@routeflow/types";

/**
 * W-1496 T1: `mayUse` is the ONE answer to "may this staff member use this page or action" (web and mobile will
 * share it; nothing calls it yet). Pure: role + denied groups + plan flag state in, boolean out.
 */

const FLAG_ON = { enabled: true, resolved: true, failed: false };
const analyticsPlan = (state: { enabled: boolean; resolved: boolean; failed: boolean }) => ({
  "flag.analytics": state,
});
const op = (
  deniedGroups: readonly string[] | undefined,
  plan?: SurfacePrincipal["plan"],
): SurfacePrincipal => ({ role: "OPERATOR", deniedGroups, plan });
const page = (p: SurfacePrincipal, href: string) => mayUse(p, { page: href });

describe("mayUse closed world (T1-3)", () => {
  it("T1-3: a page nobody registered is refused even for a full-access operator", () => {
    expect(routeAccess("/no-such-page")).toEqual({ kind: "UNKNOWN" });
    expect(page(op([]), "/no-such-page")).toBe(false);
    expect(page({ role: "TENANT_ADMIN", deniedGroups: [] }, "/no-such-page")).toBe(false);
  });

  it("an href that is a real route but not a menu page (no PAGE_SURFACES row) is refused", () => {
    expect(routeAccess("/orders/123").kind).toBe("GROUPS");
    expect(page(op([]), "/orders/123")).toBe(false);
  });
});

describe("mayUse page verdicts (T1-9)", () => {
  it("buyers and drivers never read operator rows", () => {
    expect(page({ role: "DRIVER", deniedGroups: [] }, "/routes")).toBe(false);
    expect(page({ role: "CUSTOMER", deniedGroups: [] }, "/orders")).toBe(false);
    expect(page({ role: undefined, deniedGroups: [] }, "/orders")).toBe(false);
    expect(page({ role: null, deniedGroups: [] }, "/orders")).toBe(false);
    expect(page({ role: "SUPER_ADMIN", deniedGroups: [] }, "/orders")).toBe(false);
  });

  it("TENANT_ADMIN opens an analytics page whose plan flag is on, whatever is denied", () => {
    expect(
      page(
        { role: "TENANT_ADMIN", deniedGroups: ["REPORTS"], plan: analyticsPlan(FLAG_ON) },
        "/analytics",
      ),
    ).toBe(true);
    expect(
      page({ role: "TENANT_ADMIN", deniedGroups: [], plan: analyticsPlan(FLAG_ON) }, "/analytics"),
    ).toBe(true);
  });

  it("OPERATOR: denied [] opens /analytics, denied [REPORTS] closes it", () => {
    const plan = analyticsPlan(FLAG_ON);
    expect(page(op([], plan), "/analytics")).toBe(true);
    expect(page(op(["REPORTS"], plan), "/analytics")).toBe(false);
  });

  it("any-of: /deliveries stays open while one of ORDERS|DISPATCH is held", () => {
    expect(page(op(["ORDERS"]), "/deliveries")).toBe(true);
    expect(page(op(["DISPATCH"]), "/deliveries")).toBe(true);
    expect(page(op(["ORDERS", "DISPATCH"]), "/deliveries")).toBe(false);
  });

  it("a BASE page (/settings) opens with every group denied", () => {
    const all = [
      "ORDERS",
      "DISPATCH",
      "CUSTOMERS",
      "CATALOG",
      "PRICING",
      "FINANCE",
      "REPORTS",
      "REGULATED",
    ];
    expect(page(op(all), "/settings")).toBe(true);
    expect(page(op(all), "/dashboard")).toBe(true);
  });

  it("the /compliance/:sectionId pattern row matches a concrete section, and only under /compliance", () => {
    expect(page(op([]), "/compliance/sec-1")).toBe(true);
    expect(page(op(["REGULATED"]), "/compliance/sec-1")).toBe(false);
    expect(page(op([]), "/compliance")).toBe(false);
    expect(page(op([]), "/compliance/sec-1/extra")).toBe(false);
  });

  it("ignores a query string, hash and trailing slash on the href", () => {
    expect(page(op([]), "/orders?status=PENDING")).toBe(true);
    expect(page(op([]), "/orders/")).toBe(true);
    expect(page(op(["ORDERS"]), "/orders#x")).toBe(false);
  });
});

describe("loading hides (T1-10)", () => {
  it("T1-10: an OPERATOR whose denied groups are not loaded yet opens no page and no action", () => {
    for (const s of PAGE_SURFACES) {
      const href = s.href.replace(/:[A-Za-z]+/g, "abc");
      expect({ href, ok: page(op(undefined), href) }).toEqual({ href, ok: false });
    }
    for (const action of STAFF_CAPABILITY_VALUES) {
      for (const role of ["OPERATOR", "TENANT_ADMIN"]) {
        expect(mayUse({ role, deniedGroups: undefined }, { action })).toBe(false);
      }
    }
  });
});

describe("plan AND permission (T1-11)", () => {
  it("T1-11: the plan's fail-open never reopens a permission-denied page", () => {
    const failed = analyticsPlan({ enabled: false, resolved: false, failed: true });
    expect(page(op(["REPORTS"], failed), "/analytics")).toBe(false);
    expect(page(op([], failed), "/analytics")).toBe(true);
  });

  it("a resolved flag that is off hides the page; an unresolved, unfailed flag hides it too", () => {
    expect(
      page(op([], analyticsPlan({ enabled: false, resolved: true, failed: false })), "/analytics"),
    ).toBe(false);
    expect(
      page(op([], analyticsPlan({ enabled: true, resolved: false, failed: false })), "/analytics"),
    ).toBe(false);
  });

  it("a plan-gated page with no flag state at all is hidden, and an ungated page ignores the plan", () => {
    expect(page(op([]), "/analytics")).toBe(false);
    expect(page(op([], {}), "/analytics")).toBe(false);
    expect(page(op([], {}), "/orders")).toBe(true);
  });

  it("the same plan gate applies to a TENANT_ADMIN (permission cannot reopen a plan-hidden page)", () => {
    const off = analyticsPlan({ enabled: false, resolved: true, failed: false });
    expect(page({ role: "TENANT_ADMIN", deniedGroups: [], plan: off }, "/analytics")).toBe(false);
  });
});

describe("actions (T1-12)", () => {
  const denySets: ReadonlyArray<readonly string[]> = [[], ["PRICING"], ["ORDERS"], ["FINANCE"]];
  it("T1-12: mayUse({ action }) is staffMay for every capability, deny set and staff role", () => {
    for (const action of STAFF_CAPABILITY_VALUES) {
      for (const deniedGroups of denySets) {
        for (const role of ["OPERATOR", "TENANT_ADMIN"]) {
          expect({
            action,
            deniedGroups,
            role,
            ok: mayUse({ role, deniedGroups }, { action }),
          }).toEqual({
            action,
            deniedGroups,
            role,
            ok: staffMay(role, action, deniedGroups),
          });
        }
      }
    }
  });

  it("a driver or a missing role may do no staff action", () => {
    for (const action of STAFF_CAPABILITY_VALUES) {
      expect(mayUse({ role: "DRIVER", deniedGroups: [] }, { action })).toBe(false);
      expect(mayUse({ role: undefined, deniedGroups: [] }, { action })).toBe(false);
    }
  });
});
