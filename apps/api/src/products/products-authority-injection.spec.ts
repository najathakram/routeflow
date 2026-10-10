import "reflect-metadata";
import { ProductsService } from "./products.service";
import { EntitlementAuthority } from "../billing/entitlement-authority.service";

/**
 * #2185 × #2241 merge pin. Both PRs injected `EntitlementAuthority` into ProductsService, and git's
 * auto-merge produced the constructor param TWICE (a second `private readonly authority`) — a
 * TypeScript duplicate-identifier at best, a silently shadowed dependency at worst. ProductsService
 * must construct with exactly ONE EntitlementAuthority (the single evaluation point the MSRP and
 * forecasting gates share). Nest resolves by these design:paramtypes, so this pins what DI builds.
 */
describe("ProductsService constructor — one EntitlementAuthority (#2185 × #2241)", () => {
  it("declares EntitlementAuthority exactly once among its injected dependencies", () => {
    const paramTypes: unknown[] = Reflect.getMetadata("design:paramtypes", ProductsService) ?? [];
    expect(paramTypes.length).toBeGreaterThan(0);
    expect(paramTypes.filter((t) => t === EntitlementAuthority)).toHaveLength(1);
  });
});
