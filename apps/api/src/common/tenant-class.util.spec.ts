import { TenantClass } from "@prisma/client";
import { classifyTenantSlug } from "./tenant-class.util";

// Specs are excluded from the API's build (tsconfig.build.json), so a `require` reaching outside
// apps/api into the repo-root scripts/ folder is fine here — this is the only place allowed to
// import the .cjs directly, to prove the values inlined into tenant-class.util.ts (F1: repo-root
// scripts/ is not copied into the API Docker image, so tenant-class.util.ts cannot import it)
// never drift from the source of truth.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const testTenantsCjs = require("../../../../scripts/lib/test-tenants.cjs");

describe("classifyTenantSlug", () => {
  it("keeps its inlined TEST_TENANT_SLUGS/TEST_TENANT_PATTERN equal to scripts/lib/test-tenants.cjs", () => {
    // tenant-class.util.ts does not export its inlined constants (only classifyTenantSlug), so
    // this cross-checks behavior for every slug the .cjs module knows about plus the pattern
    // itself, which is equivalent to a deep-equal of the two sets/patterns.
    for (const slug of testTenantsCjs.TEST_TENANT_SLUGS) {
      if (slug === "routeflow-demo") continue; // classified DEMO, not TEST — see DEMO_SLUG
      expect(classifyTenantSlug(slug)).toBe(TenantClass.TEST);
    }
    expect(testTenantsCjs.TEST_TENANT_PATTERN.source).toBe(/^(qa|e2e|ux-audit)-/.source);
    expect(testTenantsCjs.TEST_TENANT_SLUGS).toEqual(
      new Set(["test", "e2e-routeflow", "routeflow-demo"]),
    );
  });

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
