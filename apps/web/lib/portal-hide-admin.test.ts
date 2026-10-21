import {
  ASK_ACCOUNT_ADMIN,
  hidesFromAllPortalCustomers,
  mayHideFromAllPortal,
} from "./portal-hide-admin";

/** L5 (owner 2026-10-13): hiding products from ALL portal customers is account-admin only (mirrors the API). */
describe("portal-hide-admin", () => {
  it("the fixed control copy", () => {
    expect(ASK_ACCOUNT_ADMIN).toBe("Ask an account admin");
  });

  it("only an account admin may hide from every portal customer", () => {
    expect(mayHideFromAllPortal("TENANT_ADMIN")).toBe(true);
    expect(mayHideFromAllPortal("SUPER_ADMIN")).toBe(true);
    for (const r of ["OPERATOR", "DRIVER", "CUSTOMER", "", null, undefined]) {
      expect(mayHideFromAllPortal(r)).toBe(false);
    }
  });

  it("a FEDERAL rule reaches every portal customer; a STATE rule does not", () => {
    expect(hidesFromAllPortalCustomers({ jurisdiction: "FEDERAL" })).toBe(true);
    expect(hidesFromAllPortalCustomers({ jurisdiction: "STATE" })).toBe(false);
  });
});
