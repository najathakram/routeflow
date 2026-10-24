import { Logger } from "@nestjs/common";
import { isTestTenantSlug } from "../common/test-tenant-slug";

/**
 * M4: `FULFILMENT_SELF_SERVE` = `off` (default) | `allowlist` | `on`.
 *  - `off`, unset, empty or anything unrecognised: dark for everyone (fails closed).
 *  - `allowlist`: only the slugs in `FULFILMENT_SELF_SERVE_TENANTS` (comma separated) that pass the
 *    approved test-tenant patterns. A non-test slug in the list is ignored with a WARN.
 *  - `on`: every tenant.
 *
 * `pilot` marks the allowlisted tenants: they alone may pick the in-store modes while the registry
 * says those are "proposed". `on` is deliberately NOT the pilot.
 */
export interface FulfilmentSelfServe {
  enabled: boolean;
  pilot: boolean;
}

const logger = new Logger("FulfilmentSelfServe");
const DARK: FulfilmentSelfServe = { enabled: false, pilot: false };

export function resolveFulfilmentSelfServe(
  tenantSlug: string | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): FulfilmentSelfServe {
  const flag = env.FULFILMENT_SELF_SERVE;
  if (flag === "on") return { enabled: true, pilot: false };
  if (flag !== "allowlist") return DARK;

  const listed = (env.FULFILMENT_SELF_SERVE_TENANTS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const accepted = new Set<string>();
  for (const slug of listed) {
    if (isTestTenantSlug(slug)) accepted.add(slug);
    else {
      logger.warn(
        `FULFILMENT_SELF_SERVE_TENANTS: "${slug}" is not an approved test-tenant slug and is ignored.`,
      );
    }
  }
  if (typeof tenantSlug === "string" && accepted.has(tenantSlug)) {
    return { enabled: true, pilot: true };
  }
  return DARK;
}
