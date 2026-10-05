/**
 * The ONE resolver of an order's fulfil path (ROUTE | SHIP) from the tenant's fulfilment capability.
 * It is used by order create (staff and buyer), the standing-order templates and the merge candidate
 * search (`merge-candidates.ts`), so they can never disagree (L-167).
 *
 * Active ONLY where `capability.methods` EXCLUDES ROUTE (a ship-only business today). Everything else
 * (unset, delivery, both) is byte-identical to before: `explicit ?? stored ?? ROUTE`.
 *
 * Active rules (a ship-only business):
 *  - staff: an explicit path in `methods` is used. An explicit path EQUAL to the customer's stored path
 *    but not in `methods` is treated as omitted (the web and mobile always send the stored path), with a
 *    log line. An explicit DIFFERENT path that is not offered is a coded 400 FULFIL_METHOD_NOT_OFFERED.
 *    Omitted: the stored path when it is offered, else the capability's `staffDefault`.
 *  - buyer: the same with `portalMethods` / `portalDefault`.
 * A capability that cannot be read is a coded 503, never a guessed path.
 */
import { BadRequestException, ServiceUnavailableException } from "@nestjs/common";
import { FulfillPath } from "@prisma/client";
import { deriveFulfilmentCapability } from "../billing/fulfilment-capability";
import { API_ERROR_CODES } from "../common/api-error-codes";

export const FULFILMENT_MODEL_KEY = "fulfilment_model";

export interface FulfilPathDeps {
  featureConfig?: { getEffectiveMode(tenantId: string, key: string): Promise<string> };
  tenantId: string | null | undefined;
  logger?: { warn(message: string): void };
}

export interface FulfilPathInput {
  /** The path the request asked for (staff create body), if any. */
  explicit?: FulfillPath | null;
  /** The customer's stored default path. */
  stored?: FulfillPath | null;
  audience: "staff" | "buyer";
}

const asFulfillPaths = (methods: readonly string[]): FulfillPath[] =>
  methods.filter((m): m is FulfillPath => m === FulfillPath.ROUTE || m === FulfillPath.SHIP);

/** The path to use where the resolver is ACTIVE; `undefined` where it is not (callers keep today's rule). */
export async function activeFulfilPath(
  deps: FulfilPathDeps,
  input: FulfilPathInput,
): Promise<FulfillPath | undefined> {
  if (!deps.featureConfig || !deps.tenantId) return undefined;
  let mode: string;
  try {
    mode = await deps.featureConfig.getEffectiveMode(deps.tenantId, FULFILMENT_MODEL_KEY);
  } catch {
    throw new ServiceUnavailableException({
      code: API_ERROR_CODES.FULFIL_CAPABILITY_UNAVAILABLE,
      message: "Couldn't check how this business fulfils orders. Try again in a moment.",
    });
  }
  const cap = deriveFulfilmentCapability({ mode, counterSales: "unset", fleet: true });
  if (cap.methods.includes("ROUTE")) return undefined; // unset / delivery / both: today, exactly

  const buyer = input.audience === "buyer";
  const offered = asFulfillPaths(buyer ? cap.portalMethods : cap.methods);
  const fallback = asFulfillPaths([buyer ? (cap.portalDefault ?? "") : cap.staffDefault])[0];
  if (offered.length === 0 || !fallback) return undefined;

  let explicit = input.explicit;
  if (explicit && !offered.includes(explicit)) {
    if (explicit === input.stored) {
      deps.logger?.warn(
        `fulfil path: explicit "${explicit}" equals the customer's stored path but is not offered ` +
          `(methods ${offered.join("/")}); treated as omitted tenant=${deps.tenantId}`,
      );
      explicit = undefined;
    } else {
      throw new BadRequestException({
        code: API_ERROR_CODES.FULFIL_METHOD_NOT_OFFERED,
        message: "This business doesn't offer that way of fulfilling orders.",
      });
    }
  }
  if (explicit) return explicit;
  return input.stored && offered.includes(input.stored) ? input.stored : fallback;
}

/** The order's path: the active rules above, else today's `explicit ?? stored ?? ROUTE`. */
export async function resolveFulfilPath(
  deps: FulfilPathDeps,
  input: FulfilPathInput,
): Promise<FulfillPath> {
  return (
    (await activeFulfilPath(deps, input)) ?? input.explicit ?? input.stored ?? FulfillPath.ROUTE
  );
}
