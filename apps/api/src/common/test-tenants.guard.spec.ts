/**
 * Regression guard for the test-tenant policy allowlist
 * (scripts/lib/test-tenants.cjs — see CLAUDE.md "Test tenants & real-client data").
 *
 * Every tenant-scoped script/test entry point calls assertTestTenant before any
 * write; these specs pin the allowlist semantics so a slug can't silently start
 * passing (or a test tenant start failing) without a deliberate policy change.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const {
  isTestTenant,
  assertTestTenant,
  TEST_TENANT_SLUGS,
} = require("../../../../scripts/lib/test-tenants.cjs");

describe("test-tenant policy guard", () => {
  it("allows the named test tenants", () => {
    expect(isTestTenant("test")).toBe(true);
    expect(isTestTenant("e2e-routeflow")).toBe(true);
    expect(isTestTenant("routeflow-demo")).toBe(true);
  });

  it("allows throwaway qa-* / e2e-* / ux-audit-* slugs", () => {
    expect(isTestTenant("qa-1775782421527")).toBe(true);
    expect(isTestTenant("qa-alpha-foods-123")).toBe(true);
    expect(isTestTenant("e2e-anything")).toBe(true);
    expect(isTestTenant("ux-audit-1777265477001")).toBe(true);
  });

  it("rejects live-client-like slugs", () => {
    expect(isTestTenant("some-wholesaler")).toBe(false);
    expect(isTestTenant("acme")).toBe(false);
  });

  it("rejects empty / non-string / prefix-trick inputs", () => {
    expect(isTestTenant("")).toBe(false);
    expect(isTestTenant(undefined)).toBe(false);
    expect(isTestTenant(null)).toBe(false);
    expect(isTestTenant("qa")).toBe(false); // no hyphen — not a throwaway slug
    expect(isTestTenant("QA-upper")).toBe(false); // slugs are lowercase
    expect(isTestTenant("xqa-foo")).toBe(false); // pattern is anchored at start
    expect(isTestTenant("meshqa-foo")).toBe(false);
  });

  it("assertTestTenant returns the slug for approved tenants", () => {
    expect(assertTestTenant("test")).toBe("test");
    expect(assertTestTenant("e2e-routeflow", "spec")).toBe("e2e-routeflow");
  });

  it("assertTestTenant throws a policy error naming the offending slug", () => {
    expect(() => assertTestTenant("real-client", "spec-context")).toThrow(
      /Test-tenant policy violation.*spec-context.*"real-client"/,
    );
  });

  it("the named allowlist stays deliberate (policy change = update this spec)", () => {
    expect([...TEST_TENANT_SLUGS].sort()).toEqual(["e2e-routeflow", "routeflow-demo", "test"]);
  });
});
