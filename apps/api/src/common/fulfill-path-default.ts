import { Logger } from "@nestjs/common";

/**
 * Default fulfilment path when a client did not send one.
 *
 * The chain is: the client's value, then the customer record's own default, then a final
 * fallback that is SHIP for a tenant whose effective `fulfilment_model` feature mode is "ship"
 * and ROUTE otherwise. So the mode only replaces today's last-resort ROUTE; it never overrides a
 * value the client or the customer already holds, and any other mode (including "unset", what the
 * feature-config read returns until the mode is registered) is exactly today's chain.
 */
export const FULFILMENT_MODEL_KEY = "fulfilment_model";
export const SHIP_MODE = "ship";

export function defaultFulfillPath<T extends string>(args: {
  /** What the client sent (undefined/null = nothing). Wins whenever present. */
  dtoValue?: T | null;
  /** The customer record's stored default, when there is one (orders only). */
  customerDefault?: T | null;
  /** True only when the tenant's effective fulfilment_model is "ship" (the last-resort fallback). */
  shipMode: boolean;
}): T | "ROUTE" | "SHIP" {
  return args.dtoValue || args.customerDefault || (args.shipMode ? "SHIP" : "ROUTE");
}

/** The slice of FeatureConfigService this needs, so callers/specs can mock it at the boundary. */
export interface FulfilmentModeReader {
  getEffectiveMode(tenantId: string, key: string): Promise<string>;
}

/**
 * True when the tenant's effective `fulfilment_model` mode is "ship". Fails open to false (today's
 * chain): no reader, no tenant (e.g. SUPER_ADMIN) or any read error. Never throws.
 */
export async function isShipModeTenant(
  reader: FulfilmentModeReader | undefined,
  tenantId: string | null | undefined,
  logger?: Pick<Logger, "warn">,
): Promise<boolean> {
  if (!reader || !tenantId) return false;
  try {
    return (await reader.getEffectiveMode(tenantId, FULFILMENT_MODEL_KEY)) === SHIP_MODE;
  } catch (err) {
    logger?.warn(
      `fulfilment_model read failed for tenant ${tenantId}; using the default fulfilment chain: ${
        (err as Error)?.message ?? err
      }`,
    );
    return false;
  }
}

const resolveLogger = new Logger("resolveFulfillPath");

/**
 * The whole order-create default in one call: the client's `dto.fulfillPath`, else the customer
 * record's default, else SHIP for a ship-mode tenant, else ROUTE. The mode is read only when
 * neither of the first two exists.
 * `self` is the calling service (its public `prisma` + optional `featureConfig`), so the caller
 * stays one line. Fails open exactly like isShipModeTenant.
 */
export async function resolveFulfillPath<T extends string>(
  self: {
    prisma: { getTenantId(): string | null | undefined };
    featureConfig?: FulfilmentModeReader;
  },
  dto: { fulfillPath?: T | null },
  customer: { fulfillPath?: T | null } | null | undefined,
  user: { tenantId?: string | null },
): Promise<T> {
  const shipMode =
    dto.fulfillPath || customer?.fulfillPath
      ? false
      : await isShipModeTenant(
          self.featureConfig,
          self.prisma.getTenantId() ?? user.tenantId,
          resolveLogger,
        );
  return defaultFulfillPath({
    dtoValue: dto.fulfillPath,
    customerDefault: customer?.fulfillPath,
    shipMode,
  }) as T;
}
