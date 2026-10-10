import { EntitlementAuthority } from "../billing/entitlement-authority.service";
import { EntitlementsService } from "../billing/entitlements.service";

/**
 * Test-module provider for `EntitlementAuthority` (#2241 gates MSRP writes through it). It delegates
 * `can(tenantId, key)` to the spec's own `EntitlementsService` mock (`hasFlag`), so the flag stubs a
 * spec already has keep deciding. A mock without `hasFlag` answers false (fail closed, flag OFF).
 *
 * Add it next to the spec's `{ provide: EntitlementsService, ... }` entry — it injects that mock.
 */
export const entitlementAuthorityFromEntitlements = {
  provide: EntitlementAuthority,
  inject: [EntitlementsService],
  useFactory: (entitlements: {
    hasFlag?: (tenantId: string, key: string) => Promise<boolean>;
  }) => ({
    can: (tenantId: string, key: string) =>
      entitlements?.hasFlag?.(tenantId, key) ?? Promise.resolve(false),
  }),
};
