import { TenantClass } from "@prisma/client";

/**
 * REG-743-F7: a from-scratch TS port of the same slug->class table
 * `apps/api/src/common/tenant-class.util.ts`'s `classifyTenantSlug` and
 * `apps/api/scripts/backfill-tenant-class.mjs`'s `classify()` already implement — written
 * independently (not imported/re-exported) so a bug in any ONE of the three can't silently
 * become the platform's only source of truth; `tenant-class.spec.ts` proves this file matches
 * the same fixture table the other two are cross-checked against.
 */
const EXACT_TEST_SLUGS = new Set(["test", "e2e-routeflow", "routeflow-demo"]);
const TEST_SLUG_PREFIX = /^(qa|e2e|ux-audit)-/;
const DEMO_SLUG = "routeflow-demo";
const HOUSE_TENANT_SLUG = "routeflow-hq";

/**
 * Pure, slug-only classification. DEMO and INTERNAL are checked before the generic TEST
 * pattern — `routeflow-demo` is itself in `EXACT_TEST_SLUGS` (approved for the test-tenant
 * write policy) but must classify DEMO here, not TEST.
 */
export function classifyTenantSlug(slug: string): TenantClass {
  if (slug === DEMO_SLUG) return TenantClass.DEMO;
  if (slug === HOUSE_TENANT_SLUG) return TenantClass.INTERNAL;
  if (EXACT_TEST_SLUGS.has(slug) || TEST_SLUG_PREFIX.test(slug)) return TenantClass.TEST;
  return TenantClass.PRODUCTION;
}

/**
 * Derived from the real `@prisma/client` enum — safe to value-import at runtime (the client
 * ships compiled JS), unlike `@routeflow/types`'s equivalent `TENANT_CLASS_VALUES`, which is
 * raw TypeScript and crashes `node dist/main.js` at boot on a value import (see
 * `no-runtime-workspace-imports.spec.ts`). Consumed by `create-tenant.dto.ts`'s `@IsIn`.
 */
export const TENANT_CLASS_VALUES = Object.values(TenantClass);
