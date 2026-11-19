import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  PLAN_GATED_NAV,
  arAgingLink,
  matchPlanGatedRoute,
  planFlagVisible,
} from "./plan-gated-nav";

describe("arAgingLink (UXG B8): three states x two pages", () => {
  const REPORT = "/finance/reports?report=ar-aging";
  const loading = { enabled: true, resolved: false, failed: false };
  const withReports = { enabled: true, resolved: true, failed: false };
  const without = { enabled: false, resolved: true, failed: false };
  const failed = { enabled: false, resolved: false, failed: true };

  it("plan with Reports: the report, with each page's existing label", () => {
    expect(arAgingLink(withReports, "dashboard")).toEqual({ href: REPORT, label: "Full report" });
    expect(arAgingLink(withReports, "finance")).toEqual({ href: REPORT, label: "Aging report" });
  });
  it("plan without Reports: the dashboard goes to Finance overview, Finance overview has no link", () => {
    expect(arAgingLink(without, "dashboard")).toEqual({
      href: "/finance/dashboard",
      label: "Finance overview",
    });
    expect(arAgingLink(without, "finance")).toBeNull();
  });
  it("still loading: no link on either page", () => {
    expect(arAgingLink(loading, "dashboard")).toBeNull();
    expect(arAgingLink(loading, "finance")).toBeNull();
  });
  it("fetch failed: fails open like planFlagVisible (the report link)", () => {
    expect(arAgingLink(failed, "dashboard")?.href).toBe(REPORT);
    expect(arAgingLink(failed, "finance")?.href).toBe(REPORT);
  });
});

describe("inventory pin: the AR aging report literal lives only in the helper (shrink-only)", () => {
  const WEB = resolve(__dirname, "..");
  const read = (f: string) => readFileSync(resolve(WEB, f), "utf8");
  const count = (s: string) => (s.match(/report=ar-aging/g) ?? []).length;
  it("the dashboard and Finance overview pages carry zero literals", () => {
    expect(count(read("app/(dashboard)/dashboard/page.tsx"))).toBe(0);
    expect(count(read("app/(dashboard)/finance/dashboard/page.tsx"))).toBe(0);
  });
  it("the helper's module carries exactly one", () => {
    expect(count(read("lib/plan-gated-nav.ts"))).toBe(1);
  });
});

describe("matchPlanGatedRoute", () => {
  it("matches every PLAN_GATED_NAV prefix exactly", () => {
    for (const [prefix, key] of Object.entries(PLAN_GATED_NAV)) {
      expect(matchPlanGatedRoute(prefix)).toBe(key);
    }
  });

  it("IN-3: /insights/products/[id] takes the same lock /analytics shows", () => {
    expect(matchPlanGatedRoute("/insights")).toBe("flag.analytics");
    expect(matchPlanGatedRoute("/insights/products/p1")).toBe("flag.analytics");
    expect(matchPlanGatedRoute("/insightsx")).toBeNull();
  });

  it("matches a nested path under a gated prefix", () => {
    expect(matchPlanGatedRoute("/estimates/123")).toBe("flag.estimates");
    expect(matchPlanGatedRoute("/finance/reports/export")).toBe("flag.reports");
  });

  // P0 lock-mirror hotfix: recurring invoices has no sidebar nav entry (reached from
  // within Invoices) but IS its own route with its own @RequirePlanFlag server-side
  // gate — a denied tenant deep-linking to /invoices/recurring previously got an
  // unhandled 403 instead of the graceful lock every other plan-gated route shows.
  it("matches /invoices/recurring (and nested new/[id]) to flag.recurring_invoices", () => {
    expect(matchPlanGatedRoute("/invoices/recurring")).toBe("flag.recurring_invoices");
    expect(matchPlanGatedRoute("/invoices/recurring/new")).toBe("flag.recurring_invoices");
    expect(matchPlanGatedRoute("/invoices/recurring/rec-1")).toBe("flag.recurring_invoices");
  });

  it("does not gate the rest of /invoices — only the /invoices/recurring subtree", () => {
    expect(matchPlanGatedRoute("/invoices")).toBeNull();
    expect(matchPlanGatedRoute("/invoices/inv-1")).toBeNull();
  });

  it("does not prefix-match a sibling path that merely starts with the same characters", () => {
    // "/returns-policy" starts with "/returns" as a raw string but is not "/returns" or
    // "/returns/..." — the exact-or-slash-boundary check must reject it.
    expect(matchPlanGatedRoute("/returns-policy")).toBeNull();
  });

  it("returns null for an ungated route", () => {
    expect(matchPlanGatedRoute("/dashboard")).toBeNull();
    expect(matchPlanGatedRoute("/orders")).toBeNull();
    expect(matchPlanGatedRoute("/sales-agents")).toBeNull();
  });
});

describe("planFlagVisible", () => {
  it("resolved: goes by enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: true, failed: false })).toBe(true);
    expect(planFlagVisible({ enabled: false, resolved: true, failed: false })).toBe(false);
  });

  it("unresolved (still loading): hidden regardless of enabled", () => {
    expect(planFlagVisible({ enabled: true, resolved: false, failed: false })).toBe(false);
    expect(planFlagVisible({ enabled: false, resolved: false, failed: false })).toBe(false);
  });

  it("fetch failed: shown (client fails OPEN)", () => {
    expect(planFlagVisible({ enabled: false, resolved: false, failed: true })).toBe(true);
  });
});
