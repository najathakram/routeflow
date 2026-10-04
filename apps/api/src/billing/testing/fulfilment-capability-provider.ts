import { FulfilmentCapabilityService } from "../fulfilment-capability.service";
import { deriveFulfilmentCapability } from "../fulfilment-capability";

/**
 * Business profiles 1B: the shared test provider for `FulfilmentCapabilityService`, which
 * BuyerController now injects. The seller reads `unset` (today's behaviour), so every pre-1B
 * buyer assertion holds. Add it to a hand-written `providers: [...]` array that builds
 * BuyerController; a spec that needs a configured seller supplies its own provider instead.
 */
const UNSET = deriveFulfilmentCapability({ mode: "unset", counterSales: "unset", fleet: false });

export const fulfilmentUnsetProvider = {
  provide: FulfilmentCapabilityService,
  useValue: {
    portal: async () => ({
      portalMethods: UNSET.portalMethods,
      portalDefault: UNSET.portalDefault,
    }),
    forTenant: async () => UNSET,
  },
};
