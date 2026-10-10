/**
 * The ONE resolver of an order's fulfil path (ROUTE | SHIP | PICKUP) from the tenant's fulfilment
 * capability. It is used by order create (staff and buyer), the standing-order templates and the
 * merge candidate search (`merge-candidates.ts`), so they can never disagree (L-167).
 *
 * Active ONLY where `capability.methods` EXCLUDES ROUTE (a ship-only or an in-store business). Everything
 * else (unset, delivery, both) is byte-identical to before: `explicit ?? stored ?? ROUTE`, with two
 * exceptions that are not "today" because the inputs are new: a requested PICKUP is refused (a business
 * that does not offer pickup cannot take one), and a BUYER's requested path is ignored where the portal
 * offers no choice (`portalMethods` empty = unset: the buyer gets exactly `stored ?? ROUTE`).
 *
 * Customer pickup is not staff hand-over (SA-763r): the rules above are what a BUYER may choose and what
 * a staff order falls back to. A staff member who may use POS mode (`staffMay(role, "USE_POS_MODE")`, an
 * OPERATOR or TENANT_ADMIN) who asks for PICKUP explicitly always gets PICKUP, whatever the tenant offers
 * its customers: the order is handed over at the till, so the portal's list of methods does not apply.
 * Buyers are unchanged, a DRIVER keeps the refusal, and a system caller (`role: null`, the standing-order
 * templates) never gets POS mode. The server never infers PICKUP from the user's preference: the client
 * sends the explicit path.
 *
 * Active rules, ship-only business:
 *  - staff: an explicit path in `methods` is used. An explicit path EQUAL to the customer's stored path
 *    but not in `methods` is treated as omitted (the web and mobile always send the stored path), with a
 *    log line. An explicit DIFFERENT path that is not offered is a coded 400 FULFIL_METHOD_NOT_OFFERED.
 *    Omitted: the stored path when it is offered, else the capability's `staffDefault`.
 *  - buyer: the same with `portalMethods` / `portalDefault`.
 * Active rules, in-store business (pickup / pickup_ship):
 *  - staff: ROUTE (requested, or the customer's stored default, which is ROUTE for every existing
 *    customer) means "no preference" and resolves PICKUP, never ROUTE. An explicit SHIP stays SHIP
 *    ("Ship this order instead") and an explicit PICKUP stays PICKUP; with no request a stored SHIP is
 *    SHIP, anything else PICKUP.
 *  - buyer (order ahead): omitted = PICKUP whatever the stored path; a requested path in `portalMethods`
 *    is used (pickup: PICKUP only; pickup_ship: PICKUP or SHIP); any other (ROUTE included) is a coded
 *    400 FULFIL_METHOD_NOT_OFFERED.
 * Fail-open (SA-678): `getEffectiveMode` already falls back to the registry default ("unset") on a DB
 * blip, and a throw that still escapes is logged and treated as unset (today's rule). A config blip
 * never blocks an order; at worst a ship-only order takes the request's or the customer's own path, and
 * it never opens PICKUP (a requested PICKUP is refused unless the capability read says the business
 * offers it).
 */
import { BadRequestException } from "@nestjs/common";
import { FulfillPath, UserRole } from "@prisma/client";
import type { FulfilmentCapability } from "@routeflow/types";
import { capabilityForMode } from "../billing/fulfilment-capability";
import { staffMay } from "../auth/permissions/staff-capabilities";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { FULFILMENT_MODEL_KEY } from "./order-status-invoicing";

export interface FulfilPathDeps {
  featureConfig?: { getEffectiveMode(tenantId: string, key: string): Promise<string> };
  tenantId: string | null | undefined;
  logger?: { warn(message: string): void };
}

export interface FulfilPathInput {
  /** The path the request asked for (staff create body, buyer submit), if any. */
  explicit?: FulfillPath | null;
  /** The customer's stored default path. */
  stored?: FulfillPath | null;
  audience: "staff" | "buyer";
  /**
   * The caller's role. `null` = a system caller (the standing-order templates): it never gets POS mode.
   * Required, so the compiler lists every caller that has to decide (SA-763r M1).
   */
  role: UserRole | null;
}

/** Who is asking, for the resolver and the merge search: the audience plus the role (SA-763r M1). */
export interface FulfilCaller {
  audience: "staff" | "buyer";
  role: UserRole | null;
}

/** A request principal as the resolver sees it: a CUSTOMER is the buyer audience, every other role is staff. */
export function fulfilCaller(user: { role: UserRole }): FulfilCaller {
  return { audience: user.role === UserRole.CUSTOMER ? "buyer" : "staff", role: user.role };
}

const { ROUTE, SHIP, PICKUP } = FulfillPath;

/** Staff POS mode: a staff caller whose role may use it. A system caller (`role: null`) and a buyer never may. */
const staffPosMode = (input: FulfilPathInput): boolean =>
  input.audience === "staff" && input.role !== null && staffMay(input.role, "USE_POS_MODE");

const asFulfillPaths = (methods: readonly string[]): FulfillPath[] =>
  methods.filter((m): m is FulfillPath => m === ROUTE || m === SHIP || m === PICKUP);

const notOffered = () =>
  new BadRequestException({
    code: API_ERROR_CODES.FULFIL_METHOD_NOT_OFFERED,
    message: "This business doesn't offer that way of fulfilling orders.",
  });

/** The tenant's capability from its stored mode; `undefined` = unknown (no config service, no tenant, or a read blip). */
async function readCapability(deps: FulfilPathDeps): Promise<FulfilmentCapability | undefined> {
  if (!deps.featureConfig || !deps.tenantId) return undefined;
  try {
    return capabilityForMode(
      await deps.featureConfig.getEffectiveMode(deps.tenantId, FULFILMENT_MODEL_KEY),
    );
  } catch (err) {
    deps.logger?.warn(
      `fulfil path: capability read failed, using today's rule tenant=${deps.tenantId}: ${String(err)}`,
    );
    return undefined;
  }
}

/** The path under the ACTIVE rules; `undefined` where they do not apply (the capability still offers ROUTE). */
function activePath(
  deps: FulfilPathDeps,
  cap: FulfilmentCapability,
  input: FulfilPathInput,
): FulfillPath | undefined {
  if (cap.methods.includes(ROUTE)) return undefined; // unset / delivery / both: today, exactly

  const buyer = input.audience === "buyer";
  const { explicit, stored } = input;

  if (cap.methods.includes(PICKUP)) {
    if (!buyer && !cap.methods.includes(SHIP)) {
      // Pickup-ONLY: never ships. An explicit SHIP equal to the stored path is the web/mobile habit of
      // sending the stored path (treated as omitted, logged); a different explicit SHIP is refused.
      if (explicit === SHIP) {
        if (explicit !== stored) throw notOffered();
        deps.logger?.warn(
          `fulfil path: explicit "SHIP" equals the customer's stored path but is not offered ` +
            `(methods PICKUP); treated as omitted tenant=${deps.tenantId}`,
        );
      } else if (!explicit && stored === SHIP) {
        deps.logger?.warn(
          `fulfil path: the customer's stored "SHIP" is not offered (methods PICKUP); coerced to PICKUP ` +
            `tenant=${deps.tenantId}`,
        );
      }
      return PICKUP;
    }
    if (!buyer) {
      // ROUTE is "no preference" in an in-store business (it is the column default and what old clients send).
      if (explicit === SHIP || explicit === PICKUP) return explicit;
      return stored === SHIP || stored === PICKUP ? stored : PICKUP;
    }
    if (!explicit) return PICKUP;
    if (asFulfillPaths(cap.portalMethods).includes(explicit)) return explicit;
    throw notOffered();
  }

  const offered = asFulfillPaths(buyer ? cap.portalMethods : cap.methods);
  const fallback = asFulfillPaths([buyer ? (cap.portalDefault ?? "") : cap.staffDefault])[0];
  if (offered.length === 0 || !fallback) return undefined;

  let chosen = explicit;
  if (chosen && !offered.includes(chosen)) {
    if (chosen === stored) {
      deps.logger?.warn(
        `fulfil path: explicit "${chosen}" equals the customer's stored path but is not offered ` +
          `(methods ${offered.join("/")}); treated as omitted tenant=${deps.tenantId}`,
      );
      chosen = undefined;
    } else {
      throw notOffered();
    }
  }
  if (chosen) return chosen;
  return stored && offered.includes(stored) ? stored : fallback;
}

/** The path to use where the resolver is ACTIVE; `undefined` where it is not (callers keep today's rule). */
export async function activeFulfilPath(
  deps: FulfilPathDeps,
  input: FulfilPathInput,
): Promise<FulfillPath | undefined> {
  if (input.explicit === PICKUP && staffPosMode(input)) return PICKUP;
  const cap = await readCapability(deps);
  return cap ? activePath(deps, cap, input) : undefined;
}

/** The order's path: the active rules above, else today's `explicit ?? stored ?? ROUTE` (see the header). */
export async function resolveFulfilPath(
  deps: FulfilPathDeps,
  input: FulfilPathInput,
): Promise<FulfillPath> {
  // POS mode: an explicit PICKUP from a staff member who may use it, whatever the tenant offers.
  if (input.explicit === PICKUP && staffPosMode(input)) return PICKUP;
  const cap = await readCapability(deps);
  const active = cap ? activePath(deps, cap, input) : undefined;
  if (active) return active;
  // Not active. An unknown capability (a blip, no config service) reads as unset: no portal choice.
  let explicit = input.explicit ?? undefined;
  if (input.audience === "buyer" && (cap?.portalMethods.length ?? 0) === 0) explicit = undefined;
  if (explicit === PICKUP) throw notOffered();
  return explicit ?? input.stored ?? ROUTE;
}
