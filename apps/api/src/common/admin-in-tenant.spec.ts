import { UserRole } from "@prisma/client";
import * as fs from "fs";
import * as path from "path";
import { isAdminInTenant } from "./admin-in-tenant";

/** SA-1508 A2-ADMIN: one predicate, by name. Red on master: the module does not exist. */
describe("isAdminInTenant (SA-1508 A2-ADMIN)", () => {
  it("a tenant admin with a tenant context is an admin", () => {
    expect(isAdminInTenant({ role: UserRole.TENANT_ADMIN }, "tenant-1")).toBe(true);
  });

  it("a tenant admin with no tenant context is not", () => {
    expect(isAdminInTenant({ role: UserRole.TENANT_ADMIN }, null)).toBe(false);
    expect(isAdminInTenant({ role: UserRole.TENANT_ADMIN }, undefined)).toBe(false);
    expect(isAdminInTenant({ role: UserRole.TENANT_ADMIN }, "")).toBe(false);
  });

  it("a super admin is not, with or without a tenant (impersonation is the way in)", () => {
    expect(isAdminInTenant({ role: UserRole.SUPER_ADMIN }, "tenant-1")).toBe(false);
    expect(isAdminInTenant({ role: UserRole.SUPER_ADMIN }, null)).toBe(false);
  });

  it("an impersonated tenant admin (the token carries the tenant admin's own role) is an admin", () => {
    const token = { role: UserRole.TENANT_ADMIN, impersonatedBy: "super-1" };
    expect(isAdminInTenant(token, "tenant-1")).toBe(true);
  });

  it("an operator, a driver, a customer, and no caller at all are not", () => {
    for (const role of [UserRole.OPERATOR, UserRole.DRIVER, UserRole.CUSTOMER]) {
      expect(isAdminInTenant({ role }, "tenant-1")).toBe(false);
    }
    expect(isAdminInTenant(undefined, "tenant-1")).toBe(false);
    expect(isAdminInTenant(null, "tenant-1")).toBe(false);
  });
});

describe("one predicate by name (SA-1508 A2-ADMIN structural pin)", () => {
  const SRC = path.join(__dirname, "..");
  const walk = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      if (e.isDirectory()) return e.name === "node_modules" ? [] : walk(path.join(dir, e.name));
      return e.name.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(e.name)
        ? [path.join(dir, e.name)]
        : [];
    });
  const files = walk(SRC).map((f) => [f, fs.readFileSync(f, "utf8")] as const);
  // L-364: the retired name is assembled here, so this spec never matches its own text
  const RETIRED = ["can", "Edit", "Issued", "Invoice"].join("");

  it("is not vacuous: the scan sees the tree and the definition", () => {
    expect(files.length).toBeGreaterThan(500);
    expect(files.some(([f]) => f.endsWith(path.join("common", "admin-in-tenant.ts")))).toBe(true);
  });

  it("exactly one `export function isAdminInTenant` under apps/api/src", () => {
    const defs = files.filter(([, t]) => /export function isAdminInTenant\b/.test(t));
    expect(defs.map(([f]) => path.relative(SRC, f).split(path.sep).join("/"))).toEqual([
      "common/admin-in-tenant.ts",
    ]);
  });

  it("the retired predicate name has no match in production code", () => {
    expect(files.filter(([, t]) => t.includes(RETIRED)).map(([f]) => f)).toEqual([]);
  });
});
