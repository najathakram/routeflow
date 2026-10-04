import { FulfilmentCapabilityService } from "../fulfilment-capability.service";

/**
 * Business profiles 1B: the shared test provider for `FulfilmentCapabilityService`, which
 * BuyerController injects for `GET /buyer/capabilities`. The seller reads `unset` (today's
 * behaviour). Add it to a hand-written `providers: [...]` array that builds BuyerController.
 */
export const fulfilmentUnsetProvider = {
  provide: FulfilmentCapabilityService,
  useValue: {
    forBuyer: async () => ({ portalMethods: [], portalDefault: null, fleet: false }),
  },
};
