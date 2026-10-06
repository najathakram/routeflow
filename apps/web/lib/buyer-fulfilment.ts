import {
  API_ERROR_CODES,
  type BuyerFulfilmentOffer,
  type FulfilmentMethod,
} from "@routeflow/types";

/**
 * Order ahead (buyer portal): what the buyer is offered, from `GET /buyer/sellers` `fulfilment`.
 * `[]` / `null` = no choice (today): nothing is sent and the server applies its own default.
 */
export interface BuyerFulfilmentChoice {
  /** more than one method: show the radio group */
  showChoice: boolean;
  methods: FulfilmentMethod[];
  /** the method preselected, and sent when the buyer does not choose; null = send nothing */
  defaultMethod: FulfilmentMethod | null;
}

export function buyerFulfilmentChoice(
  offer: Partial<BuyerFulfilmentOffer> | null | undefined,
): BuyerFulfilmentChoice {
  const methods = [...(offer?.portalMethods ?? [])];
  const fallback = methods.length === 1 ? methods[0] : null;
  const preferred = offer?.portalDefault && methods.includes(offer.portalDefault);
  return {
    showChoice: methods.length > 1,
    methods,
    defaultMethod: preferred ? (offer?.portalDefault ?? null) : (fallback ?? methods[0] ?? null),
  };
}

export const FULFIL_METHOD_LABEL: Record<FulfilmentMethod, string> = {
  PICKUP: "Pick up at store",
  SHIP: "Ship to me",
  ROUTE: "Delivery",
};

export const FULFIL_METHOD_NOT_OFFERED_COPY =
  "That option isn't available from this seller any more. Choose another and try again.";

/** 400 FULFIL_METHOD_NOT_OFFERED: the seller changed its offer after the portal loaded. */
export function isFulfilMethodNotOffered(err: unknown): boolean {
  const res = (err as { response?: { status?: number; data?: { code?: unknown } } } | null)
    ?.response;
  return res?.status === 400 && res.data?.code === API_ERROR_CODES.FULFIL_METHOD_NOT_OFFERED;
}
