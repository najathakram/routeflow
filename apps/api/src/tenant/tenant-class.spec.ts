import { TenantClass } from "@prisma/client";
import { classifyTenantSlug } from "./tenant-class";

/**
 * F7 (Phase 0 fix round, REG-743-F7): `apps/api/src/tenant/tenant-class.ts` is a NEW,
 * from-scratch TS port of the SAME classification table `apps/api/scripts/backfill-tenant-class.mjs`'s
 * `classify()` and `apps/api/src/common/tenant-class.util.ts`'s `classifyTenantSlug` already
 * implement (qa-, e2e-, and ux-audit- prefixed slugs classify TEST; routeflow-demo classifies
 * DEMO; routeflow-hq classifies INTERNAL; everything else classifies PRODUCTION) — it is not a
 * re-derivation or a re-export of either. This file does not exist yet, so every test below
 * fails on import.
 */
describe("classifyTenantSlug (apps/api/src/tenant/tenant-class.ts)", () => {
  it("classifies the demo tenant as DEMO", () => {
    expect(classifyTenantSlug("routeflow-demo")).toBe(TenantClass.DEMO);
  });

  it("classifies exact test slugs as TEST", () => {
    expect(classifyTenantSlug("test")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("e2e-routeflow")).toBe(TenantClass.TEST);
  });

  it("classifies qa-/e2e-/ux-audit- prefixed slugs as TEST", () => {
    expect(classifyTenantSlug("qa-smoke-1")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("e2e-1789227134183")).toBe(TenantClass.TEST);
    expect(classifyTenantSlug("ux-audit-1777265477001")).toBe(TenantClass.TEST);
  });

  it("classifies the house tenant slug as INTERNAL", () => {
    expect(classifyTenantSlug("routeflow-hq")).toBe(TenantClass.INTERNAL);
  });

  it("classifies everything else as PRODUCTION", () => {
    expect(classifyTenantSlug("acme-wholesale")).toBe(TenantClass.PRODUCTION);
  });
});
