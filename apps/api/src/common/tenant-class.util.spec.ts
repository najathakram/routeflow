import { TenantClass } from "@prisma/client";
import { classifyTenantSlug } from "./tenant-class.util";

describe("classifyTenantSlug", () => {
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
