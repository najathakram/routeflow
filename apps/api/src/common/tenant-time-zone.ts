import { Logger } from "@nestjs/common";
import type { ResolvedZone, ZoneContext } from "@routeflow/types";

/**
 * SA-738 / SA-738r: THE tenant time-zone resolver. Every server read of `TenantConfig.timezone`
 * goes through this module (pinned by `tenant-zone-single-reader.spec.ts`), so the whole API agrees
 * on one answer and one fallback.
 *
 * - One fallback value: `"UTC"`. It is already the money-date contract of `calendar-date.ts` (invoice
 *   issue/due dates, the overdue sweep, AR aging, credit notes, sales facts, the regulated reports),
 *   so a missing or invalid zone never moves a stored day.
 * - A caller passes a context OBJECT (`ZoneContext`), never a positional tenant id: adding a
 *   dimension later (a per-location zone) is a compile-safe, small diff. `locationId` is a
 *   documented seam, accepted and IGNORED in v1.
 * - Resolve ONCE per request / report and pass the zone down; never per row.
 */

/** The single fallback zone. */
export const FALLBACK_ZONE = "UTC";

/** The `select` fragment for a caller that batches the zone with other `TenantConfig` columns. */
export const TENANT_ZONE_SELECT = { timezone: true } as const;

/**
 * True when `raw` is a non-empty IANA zone name the runtime's Intl knows. UTC-offset forms
 * ("+01:00") are refused: a tenant's day boundary must follow DST rules, not a fixed offset.
 */
export function isValidTimeZone(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || !/^[A-Za-z]/.test(raw)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: raw });
    return true;
  } catch {
    return false;
  }
}

/** A stored zone value (or nothing) -> a usable zone. Pure; any non-empty string is Intl-checked. */
export function resolveTenantZone(raw: string | null | undefined): ResolvedZone {
  if (isValidTimeZone(raw)) return { zone: raw, fallback: false };
  return { zone: FALLBACK_ZONE, fallback: true };
}

/**
 * The same, from a `TenantConfig` row read with `TENANT_ZONE_SELECT` (null = no row). Pass
 * `tenantId` to get the one-warn-per-tenant-per-process log when the fallback is used.
 */
export function zoneFromConfig(
  cfg: { timezone?: string | null } | null | undefined,
  tenantId?: string,
): ResolvedZone {
  const resolved = resolveTenantZone(cfg ? cfg.timezone : null);
  if (resolved.fallback && tenantId) warnOnce(tenantId);
  return resolved;
}

/**
 * The zone ONLY when the tenant really has a valid one, else null. For the few callers whose own
 * documented fallback is not UTC (the invoice KPI tiles use the viewer's day; a billing notice
 * labels its date "(UTC)"). Everyone else wants `zoneFromConfig(...).zone`.
 */
export function configuredZone(
  cfg: { timezone?: string | null } | null | undefined,
  tenantId?: string,
): string | null {
  const { zone, fallback } = zoneFromConfig(cfg, tenantId);
  return fallback ? null : zone;
}

type ZonePrisma = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  tenantConfig: { findUnique(args: any): Promise<{ timezone?: string | null } | null> };
};

const logger = new Logger("TenantZone");
const warnedTenants = new Set<string>();
const WARNED_CAP = 5000;

/** One warn per tenant per process when the fallback was used. */
function warnOnce(tenantId: string): void {
  if (warnedTenants.has(tenantId) || warnedTenants.size >= WARNED_CAP) return;
  warnedTenants.add(tenantId);
  logger.warn(`tenant ${tenantId} has no valid time zone configured; using ${FALLBACK_ZONE}`);
}

/** Test seam: forget which tenants were warned about. */
export function resetTenantZoneWarnings(): void {
  warnedTenants.clear();
}

/**
 * The tenant's zone: its `TenantConfig.timezone` when that is a valid IANA zone, else UTC with
 * `fallback: true`. `ctx.locationId` is accepted and ignored in v1 (the per-location seam).
 */
export async function resolveZone(prisma: ZonePrisma, ctx: ZoneContext): Promise<ResolvedZone> {
  if (!ctx.tenantId) return { zone: FALLBACK_ZONE, fallback: true };
  const cfg = await prisma.tenantConfig.findUnique({
    where: { tenantId: ctx.tenantId },
    select: TENANT_ZONE_SELECT,
  });
  return zoneFromConfig(cfg, ctx.tenantId);
}

/**
 * SA-488 (#2493 item 3): the current tenant's resolved zone (delegates to `resolveZone`), or null
 * when there is no tenant context — callers then fall back to UTC through calendar-date.ts.
 * Resolved once per report, never per row.
 */
export async function tenantTimeZone(
  prisma: ZonePrisma & { getTenantId(): string | null | undefined },
  // #2556 B3: a caller that KNOWS its tenant (a fire-and-forget path with no ambient tenant
  // context) passes it in the context object; the ambient tenant is only the fallback.
  ctx?: { tenantId?: string | null; locationId?: string },
): Promise<string | null> {
  const tenantId = ctx?.tenantId || prisma.getTenantId();
  if (!tenantId) return null;
  return (await resolveZone(prisma, { tenantId, locationId: ctx?.locationId })).zone;
}
