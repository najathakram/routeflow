import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * W-1464 PR-B (SA-1538 R5): the ONE refusal in front of every Stripe session creator. Only a PRODUCTION business may
 * open a Stripe session, portal, customer or Connect link; Test, Demo, Internal, a missing class and any unknown value
 * are refused with the coded 409 and no Stripe call is made. This is the opposite safe side of
 * `autoLockClassProtected` (auto-lock-gate.ts): there an unknown class is treated as PRODUCTION, here it is refused.
 *
 * The wall adds no lock of its own. A creator calls it under whatever lock it already holds (the tenant-price lock for
 * the checkout slot, the Tenant row for the catch-up claim); `checkout-session-policy.pin.spec.ts` pins that every
 * creator in `apps/api/src` has a call in its wall file.
 */
export const LIVE_PAYMENTS_CLASS = "PRODUCTION";

/** Throws the coded 409 unless `cls` is exactly PRODUCTION. */
export function assertLivePaymentsAllowed(cls: string | null | undefined): void {
  if (cls === LIVE_PAYMENTS_CLASS) return;
  throw new ConflictException({
    code: API_ERROR_CODES.LIVE_PAYMENTS_OFF,
    message: "This is a test business. Payments are switched off.",
  });
}

/** What the wall needs of Prisma: one read of the business's class by primary key. */
export interface TenantClassReader {
  tenant: {
    findUnique(args: {
      where: { id: string };
      select: { class: true };
    }): PromiseLike<{ class?: string | null } | null>;
  };
}

/** Reads the business's class live and applies {@link assertLivePaymentsAllowed}. A missing business is refused. */
export async function assertTenantLivePaymentsAllowed(
  prisma: TenantClassReader,
  tenantId: string,
): Promise<void> {
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { class: true } });
  assertLivePaymentsAllowed(row?.class);
}
