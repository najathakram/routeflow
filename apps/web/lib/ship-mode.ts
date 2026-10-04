import { useTenantFeatures } from "./tenant-features";

/** The effective-mode key (feature registry, modes unset|delivery|ship|both|pickup). */
export const FULFILMENT_MODEL_KEY = "fulfilment_model";

/**
 * SHIP mode: the account's fulfilment model is "ship" (carrier shipping). Only then do the SHIPPING
 * semantics apply on web: "Shipped" wording, no fulfilment toggle, new orders/customers default to SHIP.
 * Anything else (the key absent, "unset", loading, an error) is today's behaviour exactly, so an existing
 * tenant, including one with both fleet modules off, never sees a change it did not ask for.
 * Display-only: the server decides the real default.
 */
export function useShipMode(): boolean {
  const { data } = useTenantFeatures();
  return data?.modes?.[FULFILMENT_MODEL_KEY] === "ship";
}
