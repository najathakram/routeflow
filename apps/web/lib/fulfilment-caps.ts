import {
  UNSET_FULFILMENT_CAPABILITIES,
  fulfilmentStatusLabel,
  preselectFulfilment,
  type FulfilmentCapability,
  type FulfilmentMethod,
} from "@routeflow/types";
import { useTenantFeatures } from "./tenant-features";

/**
 * The account's fulfilment capabilities (`capabilities.fulfilment` on GET /tenants/me/features). Until
 * that answer is known (loading, an error, an older API without the block) this is the UNSET shape, which
 * is exactly today's behaviour: ROUTE/SHIP both offered, ROUTE the default, no buyer choice. The web
 * never reads the raw feature modes.
 */
export function useFulfilmentCaps(): FulfilmentCapability {
  const { data } = useTenantFeatures();
  const caps = (data as { capabilities?: { fulfilment?: FulfilmentCapability } } | undefined)
    ?.capabilities?.fulfilment;
  // `consistent === false` (a delivery/both mode whose fleet is gone): clients keep today's ROUTE/SHIP
  // choice and every route surface, and the platform admin sees the warning. Same shape as UNSET.
  if (!caps || caps.consistent === false) return UNSET_FULFILMENT_CAPABILITIES;
  return caps;
}

/** The two paths the order/customer forms and the API can hold today. PICKUP is a capability METHOD only
 *  (not a FulfillPath), so until it lands a form that would be handed PICKUP falls back to SHIP. */
export type FormFulfilPath = "ROUTE" | "SHIP";
const toFormPath = (m: string | null | undefined): FormFulfilPath =>
  m === "ROUTE" ? "ROUTE" : "SHIP";

/** Staff-side fulfilment: whether to show the picker, what to start from, and the options to offer. */
export function useStaffFulfilment() {
  const { data } = useTenantFeatures();
  const caps = useFulfilmentCaps();
  // The form can only hold ROUTE | SHIP: options come from `methods` (never a hard-coded pair).
  const formMethods = caps.methods.filter(
    (m): m is FormFulfilPath => m === "ROUTE" || m === "SHIP",
  );
  return {
    /** The capability answer has arrived (a form must not commit a path before this). */
    known: data !== undefined,
    /** Show the per-order / per-customer fulfilment picker (more than one method the form can hold). */
    choice: formMethods.length > 1,
    methods: caps.methods as FulfilmentMethod[],
    /** The ROUTE / SHIP options the account offers, in order. */
    formMethods,
    staffDefault: caps.staffDefault,
    /** The account default as a form value (PICKUP falls back to SHIP). */
    formDefault: toFormPath(caps.staffDefault),
    /** Customer's own saved path first (when offered), else the account default. */
    pick: (customerPath?: string | null) => preselectFulfilment(caps, customerPath),
    /** `pick()` as a value the forms and the API accept; every submit and every seed goes through it. */
    pickForm: (customerPath?: string | null): FormFulfilPath =>
      toFormPath(preselectFulfilment(caps, customerPath)),
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
export function isUnsetCapabilities(c: FulfilmentCapability): boolean {
  const u = UNSET_FULFILMENT_CAPABILITIES;
  return (
    c.staffDefault === u.staffDefault &&
    c.portalMethods.length === 0 &&
    c.methods.length === u.methods.length &&
    c.methods.every((m, i) => m === u.methods[i])
  );
}
