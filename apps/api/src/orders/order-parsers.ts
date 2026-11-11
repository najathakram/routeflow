import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { UserRole } from "@prisma/client";

/**
 * Sales agents & commissions: staff-only per-order commission-rate override.
 * `0` IS a valid value ("exempt"); `undefined` means "no override given"
 * (falls back to customer/agent default rates). Gated like
 * the order-date gate (order-date.ts) — CUSTOMER/DRIVER callers may never set this.
 */
export function parseCommissionRatePct(
  raw: number | null | undefined,
  role: UserRole,
): number | null | undefined {
  if (raw === undefined) return undefined;
  if (role !== UserRole.OPERATOR && role !== UserRole.TENANT_ADMIN) {
    throw new ForbiddenException("Only staff can set a commission rate");
  }
  if (raw === null) return null;
  if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0 || raw > 100) {
    throw new BadRequestException("commissionRatePct must be between 0 and 100");
  }
  return raw;
}
