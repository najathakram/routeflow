import { isAccountAdmin } from "./auth";

describe("isAccountAdmin", () => {
  it.each(["TENANT_ADMIN", "SUPER_ADMIN"])("%s is an account admin", (role) => {
    expect(isAccountAdmin({ role })).toBe(true);
  });

  it.each(["OPERATOR", "DRIVER", "CUSTOMER", "", "tenant_admin"])(
    "%s is not an account admin",
    (role) => {
      expect(isAccountAdmin({ role })).toBe(false);
    },
  );

  it("is false for no user and for a user without a role", () => {
    expect(isAccountAdmin(null)).toBe(false);
    expect(isAccountAdmin(undefined)).toBe(false);
    expect(isAccountAdmin({})).toBe(false);
  });
});
