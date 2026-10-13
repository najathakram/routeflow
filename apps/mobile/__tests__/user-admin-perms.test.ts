import { readFileSync } from "fs";
import { join } from "path";
import { isAccountAdmin, isUserActive, statusToggleBody } from "../lib/user-admin";

/**
 * Perms PR1 (mobile): PATCH /users/:id/status is TENANT_ADMIN-only and takes { status } (ACTIVE | INACTIVE |
 * SUSPENDED). The list answers `status`, never `isActive`, so reading `isActive` showed every user as inactive,
 * and sending { isActive } was a 400. Operators see the team read-only.
 */
describe("isAccountAdmin (the one account-admin check)", () => {
  it.each([
    ["TENANT_ADMIN", true],
    ["SUPER_ADMIN", true],
    ["OPERATOR", false],
    ["DRIVER", false],
    ["CUSTOMER", false],
    [undefined, false],
  ])("%s -> %s", (role, ok) => {
    expect(isAccountAdmin(role as never)).toBe(ok);
  });
});

describe("user status: read and write the field the API uses", () => {
  it("active comes from status, not a missing isActive", () => {
    expect(isUserActive({ status: "ACTIVE" })).toBe(true);
    expect(isUserActive({ status: "INACTIVE" })).toBe(false);
    expect(isUserActive({ status: "SUSPENDED" })).toBe(false);
  });

  it("the toggle sends { status }, never { isActive }", () => {
    expect(statusToggleBody({ status: "ACTIVE" })).toEqual({ status: "INACTIVE" });
    expect(statusToggleBody({ status: "INACTIVE" })).toEqual({ status: "ACTIVE" });
    expect(statusToggleBody({ status: "SUSPENDED" })).toEqual({ status: "ACTIVE" });
  });
});

describe("the mobile team screen (source-pinned; Jest here is pure-logic only)", () => {
  const read = (...p: string[]) => readFileSync(join(__dirname, "..", ...p), "utf8");
  const screen = read("app", "(operator)", "settings", "index.tsx");
  const api = read("lib", "api", "admin.ts");

  it("PATCH /users/:id/status sends statusToggleBody, not { isActive }", () => {
    expect(api).not.toMatch(/\/status`, \{ isActive \}/);
    expect(api).toMatch(/statusToggleBody/);
  });

  it("the Activate / Deactivate control renders only for an account admin; rows read status", () => {
    const users = screen.slice(
      screen.indexOf("function UsersTab("),
      screen.indexOf("function ", screen.indexOf("function UsersTab(") + 20),
    );
    expect(users).toMatch(/isAccountAdmin\(/);
    expect(users).toMatch(/isUserActive\(/);
    expect(users).not.toMatch(/u\.isActive|user\.isActive/);
  });
});
