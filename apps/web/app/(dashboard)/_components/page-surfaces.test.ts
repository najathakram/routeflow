import { PAGE_SURFACES } from "@routeflow/types";
import { MODE_GATED_NAV, PLAN_GATED_NAV } from "@/lib/plan-gated-nav";
import { buildOperatorNav, type OperatorNavContext } from "./build-operator-nav";
import { INSIGHTS_LEAF, OPERATOR_NAV, type NavEntry } from "./nav-config";

/**
 * W-1496 T1 (SA-1548 D1 "R3a"): `PAGE_SURFACES` is the registry of every OPERATOR menu page. It must equal the menu
 * `buildOperatorNav` can produce (no extras, no gaps), and its plan / mode / add-on columns must mirror the three
 * web gates that exist today. Nothing reads the registry yet; these pins keep it from drifting before T2 wires it.
 */

const FULL_CTX: OperatorNavContext = {
  role: "OPERATOR",
  canActAsDriver: true,
  routesAccess: true,
  deliveryAccess: true,
  addonsLoading: false,
  hasSalesAgents: true,
  counterEnabled: true,
  regulatedLoading: false,
  regulatedSections: [{ id: "sec-1", name: "Acme tobacco" }],
  insightsAccess: true,
  plan: { flags: undefined, resolved: true, failed: false }, // undefined flags = every plan flag on
  modes: undefined, // undefined modes = every mode on
};

const ctx = (over: Partial<OperatorNavContext> = {}): OperatorNavContext => ({
  ...FULL_CTX,
  ...over,
});

function leafHrefs(nav: NavEntry[]): string[] {
  return nav.flatMap((e) =>
    e.kind === "leaf" ? [e.href] : e.kind === "group" ? e.children.map((c) => c.href) : [],
  );
}

/** The registry spells the one injected pattern row `/compliance/:sectionId`; the menu has a real id. */
const toMenuHref = (href: string): string =>
  href.replace("/compliance/:sectionId", "/compliance/sec-1");

describe("PAGE_SURFACES vs the operator menu (T1-6)", () => {
  it("T1-6: the registry hrefs are exactly the menu's leaf hrefs with everything on, plus Product insights", () => {
    const menu = new Set(leafHrefs(buildOperatorNav(ctx())));
    // The menu builder appends INSIGHTS_LEAF itself when insightsAccess is true; this also proves the constant.
    expect(menu.has(INSIGHTS_LEAF.href)).toBe(true);
    const fromConfig = new Set(
      OPERATOR_NAV.flatMap((e) =>
        e.kind === "leaf" ? [e.href] : e.kind === "group" ? e.children.map((c) => c.href) : [],
      ),
    );
    for (const h of fromConfig) expect(menu.has(h)).toBe(true);

    const registry = PAGE_SURFACES.map((s) => toMenuHref(s.href));
    expect(new Set(registry).size).toBe(registry.length); // one row per href
    expect([...registry].sort()).toEqual([...menu].sort());
  });
});

describe("PAGE_SURFACES.addon (T1-7)", () => {
  /** The OperatorNavContext flag each single-flag add-on page hangs off today (a reviewed pin). */
  const EXPECTED_ADDON: Record<string, string> = {
    "/routes": "routesAccess",
    "/deliveries": "deliveryAccess",
    "/orders/counter-sale": "counterEnabled",
    "/sales-agents": "hasSalesAgents",
    "/finance/commissions": "hasSalesAgents",
  };

  it("pins which pages carry an addon, and which flag", () => {
    const actual = Object.fromEntries(
      PAGE_SURFACES.filter((s) => s.addon !== undefined).map((s) => [s.href, s.addon]),
    );
    expect(actual).toEqual(EXPECTED_ADDON);
  });

  it("T1-7: with a row's addon flag off, the menu loses that href (and with it on, has it)", () => {
    const withAddon = PAGE_SURFACES.filter((s) => s.addon !== undefined);
    expect(withAddon.length).toBeGreaterThan(0);
    for (const s of withAddon) {
      const flag = s.addon as keyof OperatorNavContext;
      const off = leafHrefs(
        buildOperatorNav(ctx({ [flag]: false } as Partial<OperatorNavContext>)),
      );
      const on = leafHrefs(buildOperatorNav(ctx()));
      expect({ href: s.href, onMenu: on.includes(s.href) }).toEqual({ href: s.href, onMenu: true });
      expect({ href: s.href, offMenu: off.includes(s.href) }).toEqual({
        href: s.href,
        offMenu: false,
      });
    }
  });

  it("every addon value is a real boolean flag of OperatorNavContext", () => {
    const flags = Object.entries(FULL_CTX)
      .filter(([, v]) => typeof v === "boolean")
      .map(([k]) => k);
    for (const s of PAGE_SURFACES) if (s.addon) expect(flags).toContain(s.addon);
  });
});

describe("PAGE_SURFACES.planFlag and .mode (T1-8)", () => {
  it("T1-8: planFlag is PLAN_GATED_NAV[href] for every row (both absent allowed)", () => {
    for (const s of PAGE_SURFACES) {
      expect({ href: s.href, planFlag: s.planFlag }).toEqual({
        href: s.href,
        planFlag: PLAN_GATED_NAV[s.href],
      });
    }
  });

  it("every plan-gated menu href is in the registry with its flag (/invoices/recurring has no menu entry)", () => {
    const registry = new Set(PAGE_SURFACES.map((s) => s.href));
    for (const href of Object.keys(PLAN_GATED_NAV)) {
      if (href === "/invoices/recurring") continue;
      expect({ href, inRegistry: registry.has(href) }).toEqual({ href, inRegistry: true });
    }
  });

  it("T1-8: mode is the MODE_GATED_NAV key for the href", () => {
    for (const s of PAGE_SURFACES) {
      const gate = MODE_GATED_NAV[s.href];
      expect({ href: s.href, mode: s.mode }).toEqual({ href: s.href, mode: gate?.[0] });
    }
    expect(PAGE_SURFACES.find((s) => s.href === "/promotions")?.mode).toBe("promotions");
  });
});
