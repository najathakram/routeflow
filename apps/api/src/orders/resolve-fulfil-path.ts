import { BadRequestException, Inject, Optional } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { UNSET_CAPABILITY, type FulfilmentCapability } from "./counter-sale/capability-shape";
import {
  FULFILMENT_CAPABILITY_READER,
  type FulfilmentCapabilityReader,
} from "./counter-sale/fulfilment-capability-reader";

const { ROUTE, SHIP, PICKUP } = FulfillPath;

export interface ResolveFulfilPathInput {
  cap: FulfilmentCapability;
  actor: "staff" | "buyer";
  /** the caller's explicit choice (`dto.fulfillPath`), if any */
  requested?: FulfillPath | null;
  /** `Customer.fulfillPath` (defaults to ROUTE for every existing customer) */
  customerDefault?: FulfillPath | null;
}

const notOffered = (message: string) =>
  new BadRequestException({ code: API_ERROR_CODES.FULFIL_METHOD_NOT_OFFERED, message });

/**
 * The ONE place an order's fulfil path is decided (SA-655 item 10). Pure.
 *
 *  - Business does not offer pickup (unset, delivery, ship, both): EXACTLY today, `requested ??
 *    customerDefault ?? ROUTE`; the only change is that a requested PICKUP is refused (the order write DTO
 *    used to refuse it; the DTO now accepts the enum and this resolver is the refusal).
 *  - "In store" (pickup / pickup_ship) is a main mode. STAFF orders default to PICKUP; SHIP stays available as
 *    "Ship this order instead". BUYER orders are order-ahead, pick-up: pickup only, or pickup/ship when the
 *    portal offers both, defaulting to PICKUP.
 *
 * TRAP: `Customer.fulfillPath` defaults to ROUTE for every existing customer, and today's web
 * CreateOrderModal (`fulfillPath || "ROUTE"`) and the mobile drafts payload hard-send "ROUTE" on every
 * order. ROUTE (requested or customer default) therefore means "no preference" in an in-store mode and
 * resolves to PICKUP, never ROUTE (ROUTE is not a method an in-store business offers).
 */
export function resolveFulfilPath(input: ResolveFulfilPathInput): FulfillPath {
  const { cap, actor } = input;
  const requested = input.requested ?? undefined;
  const customerDefault = input.customerDefault ?? undefined;
  const staffPickup = actor === "staff" && cap.methods.includes(PICKUP);
  const buyerPickup = actor === "buyer" && cap.portalMethods.includes(PICKUP);

  if (staffPickup) {
    if (requested === SHIP || requested === PICKUP) return requested;
    return customerDefault === SHIP || customerDefault === PICKUP ? customerDefault : PICKUP;
  }
  if (buyerPickup) {
    if (requested == null || cap.portalMethods.includes(requested)) return requested ?? PICKUP;
    throw notOffered("This business does not offer that way of getting an order");
  }
  if (requested === PICKUP) throw notOffered("This business does not offer pickup");
  return requested ?? customerDefault ?? ROUTE;
}

/**
 * `OrdersService.create`'s edge: reads the caller's tenant capability (none bound, or a reader that yields
 * nothing, is the unset capability = today) and resolves. CUSTOMER is the buyer portal; every other role is staff.
 */
export async function resolveCreateFulfilPath(
  reader: FulfilmentCapabilityReader | undefined,
  tenant: { getTenantId(): string | null },
  user: { role: string },
  dto: { fulfillPath?: FulfillPath | null },
  customer?: { fulfillPath?: FulfillPath | null } | null,
): Promise<FulfillPath> {
  const cap = (await reader?.get(tenant.getTenantId())) ?? UNSET_CAPABILITY;
  return resolveFulfilPath({
    cap,
    actor: user.role === "CUSTOMER" ? "buyer" : "staff",
    requested: dto.fulfillPath,
    customerDefault: customer?.fulfillPath,
  });
}

/**
 * Constructor parameter decorator for OrdersService: the capability reader is bound by OrdersModule, and
 * OPTIONAL so every spec/module that builds OrdersService without one is the unset capability (= today).
 */
export const OptionalCapabilityReader = (): ParameterDecorator => (target, key, index) => {
  Inject(FULFILMENT_CAPABILITY_READER)(target, key, index);
  Optional()(target, key, index);
};
