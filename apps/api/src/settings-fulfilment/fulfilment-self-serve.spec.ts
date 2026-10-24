/**
 * M4: FULFILMENT_SELF_SERVE = off (default) | allowlist | on.
 * `allowlist` reads FULFILMENT_SELF_SERVE_TENANTS (comma separated slugs) and only slugs that pass
 * the approved test-tenant patterns count; a non-test slug is ignored with a WARN. The API cannot
 * require scripts/lib/test-tenants.cjs at runtime, so `common/test-tenant-slug.ts` mirrors it and a
 * parity block below pins the two together.
 */
import { Logger } from "@nestjs/common";
import { isTestTenantSlug } from "../common/test-tenant-slug";
import { resolveFulfilmentSelfServe } from "./fulfilment-self-serve";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cjs = require("../../../../scripts/lib/test-tenants.cjs") as {
  TEST_TENANT_SLUGS: Set<string>;
  TEST_TENANT_PATTERN: RegExp;
  isTestTenant: (slug: unknown) => boolean;
};

const env = (over: Record<string, string | undefined>): NodeJS.ProcessEnv =>
  ({ ...over }) as NodeJS.ProcessEnv;

afterEach(() => jest.restoreAllMocks());

describe("resolveFulfilmentSelfServe", () => {
  it.each([
    ["unset", undefined],
    ["off", "off"],
    ["empty", ""],
    ["an unknown value (fails closed)", "yes"],
    ["upper case on is not on", "ON"],
  ])("%s is dark for everyone", (_n, value) => {
    expect(resolveFulfilmentSelfServe("qa-acme", env({ FULFILMENT_SELF_SERVE: value }))).toEqual({
      enabled: false,
      pilot: false,
    });
  });

  it("on enables every tenant and is NOT the pilot", () => {
    for (const slug of ["qa-acme", "some-real-business", null, undefined]) {
      expect(resolveFulfilmentSelfServe(slug, env({ FULFILMENT_SELF_SERVE: "on" }))).toEqual({
        enabled: true,
        pilot: false,
      });
    }
  });

  it("allowlist enables only listed test-pattern slugs, and those are the pilot", () => {
    const e = env({
      FULFILMENT_SELF_SERVE: "allowlist",
      FULFILMENT_SELF_SERVE_TENANTS: " qa-acme , e2e-routeflow ,test",
    });
    expect(resolveFulfilmentSelfServe("qa-acme", e)).toEqual({ enabled: true, pilot: true });
    expect(resolveFulfilmentSelfServe("e2e-routeflow", e)).toEqual({ enabled: true, pilot: true });
    expect(resolveFulfilmentSelfServe("test", e)).toEqual({ enabled: true, pilot: true });
    expect(resolveFulfilmentSelfServe("qa-other", e)).toEqual({ enabled: false, pilot: false });
    expect(resolveFulfilmentSelfServe(null, e)).toEqual({ enabled: false, pilot: false });
  });

  it("a non-test slug in the list is ignored with a WARN and never enabled", () => {
    const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    const e = env({
      FULFILMENT_SELF_SERVE: "allowlist",
      FULFILMENT_SELF_SERVE_TENANTS: "acme-hardware,qa-acme",
    });
    expect(resolveFulfilmentSelfServe("acme-hardware", e)).toEqual({
      enabled: false,
      pilot: false,
    });
    expect(resolveFulfilmentSelfServe("qa-acme", e)).toEqual({ enabled: true, pilot: true });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0][0])).toMatch(/FULFILMENT_SELF_SERVE_TENANTS/);
    expect(String(warn.mock.calls[0][0])).toContain("acme-hardware");
  });

  it("an allowlist with no value enables nobody", () => {
    expect(
      resolveFulfilmentSelfServe(
        "qa-acme",
        env({ FULFILMENT_SELF_SERVE: "allowlist", FULFILMENT_SELF_SERVE_TENANTS: undefined }),
      ),
    ).toEqual({ enabled: false, pilot: false });
  });

  it("reads process.env by default", () => {
    const saved = process.env.FULFILMENT_SELF_SERVE;
    try {
      process.env.FULFILMENT_SELF_SERVE = "on";
      expect(resolveFulfilmentSelfServe("qa-acme").enabled).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.FULFILMENT_SELF_SERVE;
      else process.env.FULFILMENT_SELF_SERVE = saved;
    }
  });
});

describe("common/test-tenant-slug mirrors scripts/lib/test-tenants.cjs", () => {
  const samples = [
    "test",
    "e2e-routeflow",
    "routeflow-demo",
    "qa-acme",
    "qa-",
    "e2e-x",
    "ux-audit-1",
    "acme-hardware",
    "QA-acme",
    "qa",
    "",
    "tester",
  ];
  it.each(samples)("agrees on %j", (slug) => {
    expect(isTestTenantSlug(slug)).toBe(cjs.isTestTenant(slug));
  });
  it("rejects non-strings like the original", () => {
    for (const v of [null, undefined, 3, {}]) {
      expect(isTestTenantSlug(v as never)).toBe(cjs.isTestTenant(v));
    }
  });
  it("pins the exact approved list and pattern", () => {
    const fromMirror = ["test", "e2e-routeflow", "routeflow-demo"].filter(isTestTenantSlug);
    expect(new Set(fromMirror)).toEqual(cjs.TEST_TENANT_SLUGS);
    expect(/^(qa|e2e|ux-audit)-/.source).toBe(cjs.TEST_TENANT_PATTERN.source);
  });
});
