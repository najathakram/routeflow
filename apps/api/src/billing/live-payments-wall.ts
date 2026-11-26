import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * W-1464 PR-B (SA-1538 R5): the ONE refusal in front of every Stripe session creator. Only a PRODUCTION business may
 * open a Stripe session, portal, customer or Connect link; Test, Demo, Internal, a missing class and any unknown value
 * are refused with the coded 409 and no Stripe call is made. This is the opposite safe side of
 * `autoLockClassProtected` (auto-lock-gate.ts): there an unknown class is treated as PRODUCTION, here it is refused.
 *
 * The wall adds no lock of its own. A creator calls it under whatever lock it already holds (the tenant-price lock for
 * the checkout slot); the catch-up claim runs it BEFORE the claim opens, outside the Tenant row lock; `checkout-session-policy.pin.spec.ts` pins that every
 * creator in `apps/api/src` has a call in its wall file.
 */
export const LIVE_PAYMENTS_CLASS = "PRODUCTION";

/** SA-1547 S5: which Stripe account the configured secret key talks to. Anything unrecognised is `none` (fail closed). */
export type StripeKeyMode = "live" | "test" | "none";

/** The key mode of a Stripe secret key, from its prefix only (the key itself is never logged or returned). */
export function stripeKeyModeOf(secretKey: string | null | undefined): StripeKeyMode {
  if (!secretKey) return "none";
  if (secretKey.startsWith("sk_live_") || secretKey.startsWith("rk_live_")) return "live";
  if (secretKey.startsWith("sk_test_") || secretKey.startsWith("rk_test_")) return "test";
  return "none";
}

/** The configured key's mode: the same source as `config.stripe.secretKey` (`STRIPE_SECRET_KEY`), read when asked. */
function configuredKeyMode(): StripeKeyMode {
  return stripeKeyModeOf(process.env.STRIPE_SECRET_KEY);
}

/**
 * Throws the coded 409 unless `cls` is exactly PRODUCTION, or the Stripe key is a TEST key (SA-1547 S5: a test key
 * moves no real money, so every class may exercise checkout, portal and Connect on a test stack). With a live key
 * (prod) the rule is unchanged. `keyMode` defaults to the configured key's mode.
 */
export function assertLivePaymentsAllowed(
  cls: string | null | undefined,
  keyMode: StripeKeyMode = configuredKeyMode(),
): void {
  if (cls === LIVE_PAYMENTS_CLASS || keyMode === "test") return;
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
  keyMode: StripeKeyMode = configuredKeyMode(),
): Promise<void> {
  const row = await prisma.tenant.findUnique({ where: { id: tenantId }, select: { class: true } });
  assertLivePaymentsAllowed(row?.class, keyMode);
}

/** The audit row a webhook leaves when the wall holds a change instead of applying it. */
export const LIVE_PAYMENTS_HELD_ACTION = "LIVE_PAYMENTS_HELD";

/** True for the wall's own coded 409 (and nothing else). */
export function isLivePaymentsRefusal(err: unknown): boolean {
  if (!(err instanceof ConflictException)) return false;
  const body = err.getResponse() as { code?: string } | string;
  return typeof body === "object" && body?.code === API_ERROR_CODES.LIVE_PAYMENTS_OFF;
}

/**
 * A WEBHOOK that the wall refuses must not throw: a thrown 409 would start Stripe's multi-day retry of an event that
 * can never succeed. The change is recorded as held (one audit row, best effort) with a domain-only log line (ids and
 * the kind of change, no names, amounts or keys), and the handler returns so the event is acknowledged. Nothing was
 * charged: the wall runs before the first Stripe write. Request paths keep the coded 409.
 */
export async function recordLivePaymentsHeld(
  deps: {
    prisma: { auditLog: { create(args: { data: Record<string, unknown> }): PromiseLike<unknown> } };
    logger: { warn(message: string): void };
  },
  held: {
    tenantId: string | null;
    entityType: string;
    entityId: string | null;
    what: string;
    /** Extra ids for the audit row (no names, amounts or keys). */
    meta?: Record<string, string | null>;
  },
): Promise<void> {
  deps.logger.warn(
    `Live payments held for tenant ${held.tenantId}: ${held.what} (${held.entityType} ${held.entityId ?? "-"}) - ` +
      `not a PRODUCTION business, nothing charged, event acknowledged`,
  );
  try {
    await deps.prisma.auditLog.create({
      data: {
        tenantId: held.tenantId,
        action: LIVE_PAYMENTS_HELD_ACTION,
        entityType: held.entityType,
        entityId: held.entityId,
        meta: { what: held.what, ...(held.meta ?? {}) },
      },
    });
  } catch {
    // best effort: the log line above is the trail if the row cannot be written
  }
}
