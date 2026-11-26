import * as fs from "fs";
import * as path from "path";
import {
  PAGE_SURFACES,
  PERMISSION_ROUTE_MAP,
  routeAccess,
  type RouteAccess,
} from "@routeflow/types";
import { PERMISSION_MAP } from "../auth/permissions/permission-map.pinned";

/**
 * W-1496 T1 (SA-1548 D1 "R3a"): the route map is a CLOSED world and every menu page agrees with the server route it
 * reads. Pins `packages/types/api/permissions.ts` (`routeAccess`) and `surface-access.ts` (`PAGE_SURFACES`).
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DASHBOARD = path.join(REPO_ROOT, "apps", "web", "app", "(dashboard)");

/** What the server row says, in the same shape `routeAccess` answers with. UNGUARDED has no route-map equivalent. */
function serverAccess(row: string): RouteAccess | "UNGUARDED" {
  if (row === "UNGUARDED") return "UNGUARDED";
  if (row === "BASE") return { kind: "BASE" };
  if (row === "ADMIN") return { kind: "ADMIN" };
  return { kind: "GROUPS", anyOf: row.split("|").sort() as never };
}

describe("routeAccess (T1-1, T1-3)", () => {
  it("T1-1: /insights is a REPORTS page and /shipments a FINANCE page (they were silently open)", () => {
    expect(routeAccess("/insights")).toEqual({ kind: "GROUPS", anyOf: ["REPORTS"] });
    expect(routeAccess("/shipments")).toEqual({ kind: "GROUPS", anyOf: ["FINANCE"] });
  });

  it("T1-3: a path with no entry is UNKNOWN (closed), including a near miss of a real prefix", () => {
    expect(routeAccess("/no-such-page")).toEqual({ kind: "UNKNOWN" });
    expect(routeAccess("/")).toEqual({ kind: "UNKNOWN" });
    expect(routeAccess("/ordersx")).toEqual({ kind: "UNKNOWN" });
  });

  it("keeps the longest-prefix rule: a deeper entry narrows a BASE parent", () => {
    expect(routeAccess("/settings")).toEqual({ kind: "BASE" });
    expect(routeAccess("/settings/billing")).toEqual({ kind: "BASE" });
    expect(routeAccess("/settings/restrictions/rules")).toEqual({
      kind: "GROUPS",
      anyOf: ["REGULATED"],
    });
  });
});

describe("closed world (T1-2, T1-4)", () => {
  it("T1-2: every top-level dashboard directory has a route-map entry", () => {
    const dirs = fs
      .readdirSync(DASHBOARD, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("_") && !d.name.startsWith("("))
      .map((d) => d.name)
      .sort();
    expect(dirs.length).toBeGreaterThan(20);
    const unknown = dirs.filter((name) => routeAccess(`/${name}`).kind === "UNKNOWN");
    expect(unknown).toEqual([]);
  });

  it("T1-4: the BASE (and ADMIN) prefixes are pinned exactly, so a new open page is a reviewed diff", () => {
    const withAccess = PERMISSION_ROUTE_MAP.flatMap((e) => ("access" in e ? [e] : []));
    expect(
      withAccess
        .filter((e) => e.access === "BASE")
        .map((e) => e.prefix)
        .sort(),
    ).toEqual([
      "/choose-plan",
      "/dashboard",
      "/get-the-app",
      "/getting-started",
      "/purchases",
      "/settings",
    ]);
    expect(withAccess.filter((e) => e.access === "ADMIN").map((e) => e.prefix)).toEqual([]);
  });
});

/**
 * KNOWN DISAGREEMENTS (reported to the lead, NOT edited here: "never edit an existing anyOf in this PR"). Each is an
 * EXISTING route-map entry whose page's main list read is guarded differently on the server. The brief says to stop
 * and send the lead this list; the exemption keeps the pin green without hiding it. Each row must keep disagreeing
 * (asserted below), so fixing the entry (or the server) forces this list to shrink.
 */
const KNOWN_DISAGREEMENTS: Readonly<Record<string, string>> = {
  "/deliveries": "route map ORDERS|DISPATCH; RoutesController.findAll is DISPATCH only",
  "/drivers": "route map DISPATCH; DriversController.findAll is BASE",
  "/customers": "route map CUSTOMERS; CustomersController.findAll is BASE",
  "/inventory": "route map CATALOG; InventoryController.getStockOverview is BASE",
  "/products": "route map CATALOG; ProductsController.findAll is BASE",
  "/credit-notes": "route map FINANCE; CreditNotesController.findAll is UNGUARDED",
};

function agrees(href: string, primaryRead: string): boolean {
  const server = serverAccess(PERMISSION_MAP[primaryRead]);
  const page = routeAccess(href);
  if (server === "UNGUARDED") return page.kind === "BASE";
  if (page.kind === "GROUPS" && server.kind === "GROUPS") {
    return JSON.stringify([...page.anyOf].sort()) === JSON.stringify(server.anyOf);
  }
  return page.kind === server.kind;
}

describe("PAGE_SURFACES agree with the server (T1-5)", () => {
  it("one row per href, and every primaryRead is a real PERMISSION_MAP key", () => {
    const hrefs = PAGE_SURFACES.map((s) => s.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
    for (const s of PAGE_SURFACES) {
      expect({ href: s.href, known: s.primaryRead in PERMISSION_MAP }).toEqual({
        href: s.href,
        known: true,
      });
    }
  });

  it("T1-5: routeAccess(href) equals the server row of the page's primaryRead (UNGUARDED only for a BASE page)", () => {
    const disagree = PAGE_SURFACES.filter((s) => !agrees(s.href, s.primaryRead)).map((s) => s.href);
    expect(disagree.sort()).toEqual(Object.keys(KNOWN_DISAGREEMENTS).sort());
  });

  it("every known disagreement is still a real one and a real menu page (shrink the list when fixed)", () => {
    for (const href of Object.keys(KNOWN_DISAGREEMENTS)) {
      const row = PAGE_SURFACES.find((s) => s.href === href);
      expect({ href, inRegistry: row !== undefined }).toEqual({ href, inRegistry: true });
      expect({ href, agrees: agrees(href, row!.primaryRead) }).toEqual({ href, agrees: false });
    }
  });

  it("every href resolves to a known route (the registry never carries an UNKNOWN page)", () => {
    for (const s of PAGE_SURFACES) {
      // /compliance/:sectionId is a pattern row; its concrete form is what the router sees.
      const concrete = s.href.replace(/:[A-Za-z]+/g, "abc");
      expect({ href: s.href, kind: routeAccess(concrete).kind }).not.toEqual({
        href: s.href,
        kind: "UNKNOWN",
      });
    }
  });
});
