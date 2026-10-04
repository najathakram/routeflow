import {
  UNSET_FULFILMENT_CAPABILITIES,
  fulfilmentStatusLabel,
  preselectFulfilment,
  type FulfilmentCapabilities,
  type FulfilmentMethod,
} from "@routeflow/types";
import { useTenantFeatures } from "./tenant-features";

/**
 * The account's fulfilment capabilities (`capabilities.fulfilment` on GET /tenants/me/features). Until
 * that answer is known (loading, an error, an older API without the block) this is the UNSET shape, which
 * is exactly today's behaviour: ROUTE/SHIP both offered, ROUTE the default, no buyer choice. The web
 * never reads the raw feature modes.
 */
export function useFulfilmentCaps(): FulfilmentCapabilities {
  const { data } = useTenantFeatures();
  const caps = (data as { capabilities?: { fulfilment?: FulfilmentCapabilities } } | undefined)
    ?.capabilities?.fulfilment;
  return caps ?? UNSET_FULFILMENT_CAPABILITIES;
}

/** Staff-side fulfilment: whether to show the picker, what to start from, and the options to offer. */
export function useStaffFulfilment() {
  const caps = useFulfilmentCaps();
  return {
    /** Show the per-order / per-customer fulfilment picker (more than one method on offer). */
    choice: caps.methods.length > 1,
    methods: caps.methods as FulfilmentMethod[],
    staffDefault: caps.staffDefault,
    /** Customer's own saved path first (when offered), else the account default. */
    pick: (customerPath?: string | null) => preselectFulfilment(caps, customerPath),
  };
}

/** The word for a status: per ORDER when its fulfillPath is given, else the account's staffDefault
 *  (filters, the dashboard strip). `normal` is the label used today and is the fallback. */
export function useOrderStatusLabel() {
  const caps = useFulfilmentCaps();
  // An account with no fulfilment mode set keeps today's words everywhere, even for a SHIP order.
  const unset = isUnsetCapabilities(caps);
  return (status: string, normal: string, fulfillPath?: string | null) =>
    unset ? normal : fulfilmentStatusLabel(fulfillPath ?? caps.staffDefault, status, normal);
}

/** True for the "no fulfilment mode set" shape: today's behaviour, pinned unchanged. */
export function isUnsetCapabilities(c: FulfilmentCapabilities): boolean {
  const u = UNSET_FULFILMENT_CAPABILITIES;
  return (
    c.staffDefault === u.staffDefault &&
    c.portalMethods.length === 0 &&
    c.methods.length === u.methods.length &&
    c.methods.every((m, i) => m === u.methods[i])
  );
}
