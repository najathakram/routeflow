/**
 * The fulfilment capability a tenant resolves to, copied from PR #3188
 * (packages/types/api/fulfilment.ts `FulfilmentCapability`, derived by
 * apps/api/src/billing/fulfilment-capability.ts `deriveFulfilmentCapability`).
 *
 * TODO(#3188): when that PR lands on master, delete this file's type and import `FulfilmentCapability`
 * from "@routeflow/types" (type-only: API source never value-imports that package), and replace
 * DefaultFulfilmentCapabilityReader with a reader over `deriveFulfilmentCapability`.
 */
export type FulfilmentMethod = "ROUTE" | "SHIP" | "PICKUP";

export interface FulfilmentCapability {
  methods: FulfilmentMethod[];
  staffDefault: FulfilmentMethod;
  staffOpensAs: "order" | "counter";
  portalMethods: FulfilmentMethod[];
  portalDefault: FulfilmentMethod | null;
  counter: "always" | "optional" | "off";
  fleet: boolean;
  consistent: boolean;
}

/** "Unset = today": what #3188 derives for a tenant with no fulfilment mode and no counter switch. */
export const UNSET_CAPABILITY: FulfilmentCapability = {
  methods: ["ROUTE", "SHIP"],
  staffDefault: "ROUTE",
  staffOpensAs: "order",
  portalMethods: [],
  portalDefault: null,
  counter: "off",
  fleet: true,
  consistent: true,
};

/** The ONE counter-sale gate: an in-store tenant ("always") or one that switched counter sales on ("optional"). */
export function counterSaleGate(cap: FulfilmentCapability): boolean {
  return cap.counter === "always" || cap.counter === "optional";
}
