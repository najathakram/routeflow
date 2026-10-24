import type { FulfilmentCapability } from "@routeflow/types";

/**
 * The ONE counter-sale gate: an in-store tenant ("always") or one that switched counter sales on
 * ("optional"). The capability type is #3188's shared `FulfilmentCapability` (type-only import: API
 * source never value-imports @routeflow/types); the capability itself is derived by
 * `deriveFulfilmentCapability` through `readFulfilmentCapability`.
 */
export function counterSaleGate(cap: FulfilmentCapability): boolean {
  return cap.counter === "always" || cap.counter === "optional";
}
