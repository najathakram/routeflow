import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { TENANT_ZONE_SELECT, canonicalWritableTimeZone } from "../common/tenant-time-zone";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { PrismaService } from "../prisma/prisma.service";

/** The audit action of a tenant time-zone change (SA-738, R16-4). */
export const TENANT_TIMEZONE_CHANGED_ACTION = "TENANT_TIMEZONE_CHANGED";

/**
 * A client-supplied zone -> the zone to STORE (case-corrected), or a 400 `INVALID_TIME_ZONE`. The
 * same predicate (`canonicalWritableTimeZone`) the DTO writers run through `@IsTenantTimeZone()`:
 * an offset ("+01:00"), a fixed-offset alias ("EST", "Etc/GMT+5") and a blank string are refused.
 */
export function assertValidTenantTimeZone(raw: unknown): string {
  const value = canonicalWritableTimeZone(raw);
  if (value === null) {
    throw new BadRequestException({
      code: API_ERROR_CODES.INVALID_TIME_ZONE,
      message: "timezone must be an IANA time zone such as America/Chicago",
    });
  }
  return value;
}

/**
 * TENANT_ADMIN, or SUPER_ADMIN. SUPER_ADMIN is allowed on purpose: `RolesGuard` lets it satisfy every
 * role (so it reaches this route), and an impersonation token acts as a tenant admin; the audit row
 * stamps `impersonatedBy`. Operators (and everyone else) are refused.
 */
export function canChangeTenantTimeZone(user: Pick<JwtPayload, "role"> | undefined): boolean {
  return user?.role === UserRole.TENANT_ADMIN || user?.role === UserRole.SUPER_ADMIN;
}

/**
 * The pre-write gate for PATCH /settings `timezone`: 403 for anyone but a tenant admin, then 400
 * `INVALID_TIME_ZONE` for a bad zone. Runs BEFORE any other field is written. Returns the zone.
 */
export function prepareTenantTimeZoneChange(
  user: Pick<JwtPayload, "role"> | undefined,
  raw: unknown,
): string {
  if (!canChangeTenantTimeZone(user)) {
    throw new ForbiddenException("Only a tenant admin can change the time zone");
  }
  return assertValidTenantTimeZone(raw);
}

/**
 * PATCH /settings `timezone` (SA-738 R16-4): the audited write of an already-validated `zone`
 * (see `prepareTenantTimeZoneChange`). The new zone and the audit row (actor, old, new) commit
 * together, so a change is never unrecorded. Stored dates are NOT recomputed: the zone changes the
 * day boundary from now on only.
 */
export async function changeTenantTimeZone(
  prisma: Pick<PrismaService, "tenantTransaction">,
  args: { tenantId: string; user: JwtPayload | undefined; zone: string },
): Promise<{ changed: boolean }> {
  const { tenantId, user, zone } = args;
  return prisma.tenantTransaction(async (tx) => {
    const row = await tx.tenantConfig.findUnique({
      where: { tenantId },
      select: TENANT_ZONE_SELECT,
    });
    const stored: string | null = row?.timezone ?? null;
    // compare on the canonical form, so a stored "america/chicago" is not rewritten to "America/Chicago"
    const previous = (stored && canonicalWritableTimeZone(stored)) || stored;
    if (previous === zone) return { changed: false };
    await tx.tenantConfig.upsert({
      where: { tenantId },
      create: { tenantId, timezone: zone },
      update: { timezone: zone },
    });
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: user?.sub ?? null,
        impersonatedBy: user?.impersonatedBy ?? null,
        action: TENANT_TIMEZONE_CHANGED_ACTION,
        entityType: "TenantConfig",
        entityId: tenantId,
        meta: { old: stored, new: zone },
      },
    });
    return { changed: true };
  });
}
