/**
 * The account's fulfilment capability for staff forms and actions (row 505). Pure (no react-query / api-client
 * imports, so it stays Jest-testable); the hook is `useStaffFulfilment` in `tenant-features.ts`. Mirrors
 * `apps/web/lib/fulfilment-caps.ts`: until the answer is known (loading, an error, an older API without the
 * block) or when it says `consistent === false`, this is the UNSET shape, which is exactly today's behaviour
 * (ROUTE and SHIP both offered, ROUTE the default). Never reads the raw feature modes.
 */
import {
  UNSET_FULFILMENT_CAPABILITIES,
  type FulfilmentCapability,
} from "@routeflow/types/api/fulfilment";

/** The two paths an order write can hold. PICKUP is a capability METHOD only, so a form handed PICKUP uses SHIP. */
export type FormFulfilPath = "ROUTE" | "SHIP";
const toFormPath = (m: string | null | undefined): FormFulfilPath =>
  m === "ROUTE" ? "ROUTE" : "SHIP";

type FeaturesLike =
  | { capabilities?: { fulfilment?: Partial<FulfilmentCapability> | null } | null }
  | null
  | undefined;

export function fulfilmentCapsFrom(features: FeaturesLike): FulfilmentCapability {
  const caps = features?.capabilities?.fulfilment;
  if (!caps || !Array.isArray(caps.methods) || caps.consistent === false) {
    return UNSET_FULFILMENT_CAPABILITIES;
  }
  return caps as FulfilmentCapability;
}

/** The ROUTE / SHIP options the account offers (in its order) and the account default as a form value. */
export function staffFormFulfilment(features: FeaturesLike): {
  formMethods: FormFulfilPath[];
  formDefault: FormFulfilPath;
} {
  const caps = fulfilmentCapsFrom(features);
  return {
    formMethods: caps.methods.filter((m): m is FormFulfilPath => m === "ROUTE" || m === "SHIP"),
    formDefault: toFormPath(caps.staffDefault),
  };
}
