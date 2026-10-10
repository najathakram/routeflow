import * as fs from "fs";
import * as path from "path";
import { OperatorPermissionGroup as PrismaGroup } from "@prisma/client";
import {
  GROUP_INTRODUCED,
  OPERATOR_PERMISSION_GROUP_VALUES,
  PERMISSION_GROUPS,
  PERMISSION_ROUTE_MAP,
  allPermissionGroups,
  permissionForPath,
} from "@routeflow/types";

/**
 * The shared per-operator feature-group contract (`packages/types/api/permissions.ts`): the switch
 * list, the "introduced" map and the route map are all derived from, or pinned to, the one enum.
 */

const REPO_ROOT = path.resolve(__dirname, "../../../..");
const DASHBOARD = path.join(REPO_ROOT, "apps", "web", "app", "(dashboard)");

describe("PERMISSION_GROUPS", () => {
  it("covers every enum value exactly once, in enum order, numbered 1..n", () => {
    expect(PERMISSION_GROUPS.map((g) => g.key)).toEqual([...OPERATOR_PERMISSION_GROUP_VALUES]);
    expect(PERMISSION_GROUPS.map((g) => g.order)).toEqual(
      OPERATOR_PERMISSION_GROUP_VALUES.map((_, i) => i + 1),
    );
  });

  it("follows the Prisma enum order, so the API and the switches list the groups the same way", () => {
    expect([...OPERATOR_PERMISSION_GROUP_VALUES]).toEqual(Object.values(PrismaGroup));
  });

  it("has a distinct label and a one-line description for every group", () => {
    const labels = PERMISSION_GROUPS.map((g) => g.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const g of PERMISSION_GROUPS) {
      expect(g.label.trim().length).toBeGreaterThan(0);
      expect(g.description.trim().length).toBeGreaterThan(10);
      expect(g.description).not.toContain("\n");
    }
  });

  it("allPermissionGroups() is every group in order and a fresh array each call", () => {
    const a = allPermissionGroups();
    expect(a).toEqual([...OPERATOR_PERMISSION_GROUP_VALUES]);
    a.pop();
    expect(allPermissionGroups()).toHaveLength(OPERATOR_PERMISSION_GROUP_VALUES.length);
  });
});

describe("GROUP_INTRODUCED", () => {
  it("has an entry for every enum value and for nothing else", () => {
    expect(Object.keys(GROUP_INTRODUCED).sort()).toEqual(
      [...OPERATOR_PERMISSION_GROUP_VALUES].sort(),
    );
  });

  it("each entry names a month and a known restrictedDefault", () => {
    for (const key of OPERATOR_PERMISSION_GROUP_VALUES) {
      expect(GROUP_INTRODUCED[key].addedIn).toMatch(/^\d{4}-\d{2}$/);
      expect(["OFF", "ON"]).toContain(GROUP_INTRODUCED[key].restrictedDefault);
    }
  });

  it("the nine baseline groups are all ON for restricted operators", () => {
    for (const key of OPERATOR_PERMISSION_GROUP_VALUES) {
      expect(GROUP_INTRODUCED[key]).toEqual({ addedIn: "2026-10", restrictedDefault: "ON" });
    }
  });
});

describe("PERMISSION_ROUTE_MAP + permissionForPath", () => {
  it("is non-empty and every entry is well formed (leading slash, no trailing slash, known groups)", () => {
    expect(PERMISSION_ROUTE_MAP.length).toBeGreaterThan(10);
    for (const entry of PERMISSION_ROUTE_MAP) {
      expect(entry.prefix).toMatch(/^\/[a-z-]+(\/[a-z-]+)*$/);
      expect(entry.anyOf.length).toBeGreaterThan(0);
      for (const g of entry.anyOf) expect(OPERATOR_PERMISSION_GROUP_VALUES).toContain(g);
    }
    const prefixes = PERMISSION_ROUTE_MAP.map((e) => e.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("every prefix is a real dashboard route directory", () => {
    expect(fs.existsSync(DASHBOARD)).toBe(true);
    for (const entry of PERMISSION_ROUTE_MAP) {
      const dir = path.join(DASHBOARD, ...entry.prefix.split("/").filter(Boolean));
      expect({ prefix: entry.prefix, exists: fs.existsSync(dir) }).toEqual({
        prefix: entry.prefix,
        exists: true,
      });
    }
  });

  it.each([
    ["/orders", ["ORDERS"]],
    ["/orders/123", ["ORDERS"]],
    ["/orders/counter-sale", ["ORDERS"]],
    ["/routes/abc/dispatch", ["DISPATCH"]],
    ["/drivers", ["DISPATCH"]],
    ["/customers/42", ["CUSTOMERS"]],
    ["/products/create", ["CATALOG"]],
    ["/inventory/stock-counts", ["CATALOG"]],
    ["/promotions", ["PRICING"]],
    ["/tobacco", ["REGULATED"]],
    ["/invoices/new", ["FINANCE"]],
    ["/vendor-bills/9", ["FINANCE"]],
    ["/analytics", ["REPORTS"]],
  ])("%s -> %j", (route, groups) => {
    expect(permissionForPath(route)).toEqual(groups);
  });

  it("the longest matching prefix wins (a deeper entry may widen or narrow its parent)", () => {
    expect(permissionForPath("/finance")).toEqual(["FINANCE"]);
    expect(permissionForPath("/finance/payments")).toEqual(["FINANCE"]);
    expect(permissionForPath("/finance/dashboard")).toEqual(["FINANCE", "REPORTS"]);
    expect(permissionForPath("/finance/reports/pl")).toEqual(["REPORTS"]);
    expect(permissionForPath("/settings/restrictions/rules")).toEqual(["REGULATED"]);
    expect(permissionForPath("/deliveries/new")).toEqual(["ORDERS", "DISPATCH"]);
  });

  it("matches whole path segments only", () => {
    expect(permissionForPath("/ordersx")).toBeNull();
    expect(permissionForPath("/orders-archive/1")).toBeNull();
    expect(permissionForPath("/finances")).toBeNull();
  });

  it("returns null for routes that are not tied to a group", () => {
    expect(permissionForPath("/")).toBeNull();
    expect(permissionForPath("/dashboard")).toBeNull();
    expect(permissionForPath("/settings")).toBeNull();
    expect(permissionForPath("/settings/billing")).toBeNull();
    expect(permissionForPath("/getting-started")).toBeNull();
  });

  it("ignores query string, hash and a trailing slash", () => {
    expect(permissionForPath("/orders?status=PENDING")).toEqual(["ORDERS"]);
    expect(permissionForPath("/orders/12#lines")).toEqual(["ORDERS"]);
    expect(permissionForPath("/orders/")).toEqual(["ORDERS"]);
  });

  it("returns a copy: mutating the result never changes the map", () => {
    const first = permissionForPath("/finance/dashboard");
    first?.push("PRICING");
    expect(permissionForPath("/finance/dashboard")).toEqual(["FINANCE", "REPORTS"]);
  });
});
