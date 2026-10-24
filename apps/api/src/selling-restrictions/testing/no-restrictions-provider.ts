import { SellingRestrictionsService } from "../selling-restrictions.service";

/**
 * Shared test provider for `SellingRestrictionsService` where a buyer-facing service only needs its
 * portal-hide read (`restrictedProductIdsFor`): nothing is restricted, so every pre-existing
 * visibility assertion holds. A spec that needs hidden ids supplies its own provider instead.
 */
export const noRestrictionsProvider = {
  provide: SellingRestrictionsService,
  useValue: { restrictedProductIdsFor: jest.fn().mockResolvedValue(new Set<string>()) },
};
