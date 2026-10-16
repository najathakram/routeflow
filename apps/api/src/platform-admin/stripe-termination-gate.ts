import { ConflictException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { isTerminalStripeSubscriptionStatus } from "../billing/stripe-period";
import { AdminAuditAction, type AdminAuditActionCode } from "./audit-actions.constant";
import type { PrismaService } from "../prisma/prisma.service";
import type { StripeService } from "../billing/stripe.service";

/** 409 TENANT_CANCEL_SUBSCRIPTION_FIRST: a status CANCELLED over a live Stripe subscription would keep billing. */
export function cancelSubscriptionFirstRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.TENANT_CANCEL_SUBSCRIPTION_FIRST,
    message: "This tenant has a live subscription. Cancel the subscription first.",
  });
}

/** 409 STRIPE_ACCOUNT_MISMATCH: Stripe knows neither the subscription nor the customer - wrong key or mode. */
export function stripeAccountMismatchRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.STRIPE_ACCOUNT_MISMATCH,
    message:
      "Stripe can't find this tenant's subscription or customer. Check the Stripe key and mode before cancelling.",
  });
}

/**
 * 409 STRIPE_SUBSCRIPTION_OWNER_MISMATCH: the subscription Stripe returned for the stored id is not provably this
 * tenant's (another customer, another tenant's metadata, or no stored customer to compare against).
 */
export function stripeSubscriptionOwnerMismatchRefusal(
  noStoredCustomer = false,
): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.STRIPE_SUBSCRIPTION_OWNER_MISMATCH,
    message: noStoredCustomer
      ? "This tenant has a Stripe subscription but no Stripe customer on file, so the subscription's owner can't be confirmed. Check the tenant's billing record before cancelling."
      : "This subscription belongs to a different Stripe customer. Check the tenant's billing record before cancelling.",
  });
}

/** 409 STRIPE_NOT_CONFIGURED: no Stripe key in this environment (or Stripe rejected it), so nothing can be checked. */
export function stripeNotConfiguredRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.STRIPE_NOT_CONFIGURED,
    message: "Stripe isn't connected in this environment, so the subscription can't be checked.",
  });
}

/** `reason` on a CONCURRENT_UPDATE body: the Stripe read failed, so the web shows the Stripe-specific text. */
export const STRIPE_UNCONFIRMED_REASON = "STRIPE_UNCONFIRMED";

/** 409 CONCURRENT_UPDATE (reason STRIPE_UNCONFIRMED): Stripe could not be read twice. Retryable. */
export function stripeUnconfirmedRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.CONCURRENT_UPDATE,
    reason: STRIPE_UNCONFIRMED_REASON,
    message: "This tenant's subscription could not be confirmed ended. Please retry.",
  });
}

/** 409 CONCURRENT_UPDATE (no reason): the tenant's subscription moved between the Stripe read and the row lock. */
export function tenantChangedRefusal(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.CONCURRENT_UPDATE,
    message: "This tenant changed while you were editing. Reload and try again.",
  });
}

/** How long the pre-transaction Stripe read may take, per attempt (one retry follows a failure or a timeout). */
const STRIPE_TERMINATION_READ_TIMEOUT_MS = 5_000;

async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Stripe read timed out")), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export interface StripeGateDeps {
  prisma: Pick<PrismaService, "tenantSubscription">;
  stripe: Pick<StripeService, "isConfigured" | "getSubscription" | "getCustomer">;
  logger: Logger;
  record: (
    tenantId: string,
    adminId: string | null,
    action: AdminAuditActionCode,
    meta: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** Stripe rejected the API key itself (a retry cannot help): the environment is not connected. */
const isBadKey = (e: { type?: string; statusCode?: number } | undefined): boolean =>
  e?.statusCode === 401 || e?.type === "StripeAuthenticationError";

/**
 * One Stripe read with the gate's short timeout and ONE retry. Resolves null when Stripe answers 404 /
 * resource_missing; a 401 / bad key is STRIPE_NOT_CONFIGURED at once (never retried); a read that fails or
 * times out twice is a retryable 409 (CONCURRENT_UPDATE, reason STRIPE_UNCONFIRMED).
 */
async function readStripeOrMissing<T>(
  deps: StripeGateDeps,
  id: string,
  what: string,
  read: () => Promise<T>,
) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await withTimeout(read(), STRIPE_TERMINATION_READ_TIMEOUT_MS);
    } catch (err) {
      const e = err as { code?: string; statusCode?: number; type?: string } | undefined;
      if (e?.code === "resource_missing" || e?.statusCode === 404) return null;
      if (isBadKey(e)) {
        deps.logger.warn(`Tenant ${id}: Stripe rejected the key reading ${what}; refusing`);
        throw stripeNotConfiguredRefusal();
      }
      if (attempt >= 2) {
        deps.logger.warn(`Tenant ${id}: could not read Stripe ${what} twice; refusing (retry)`);
        throw stripeUnconfirmedRefusal();
      }
    }
  }
}

/**
 * The subscription Stripe returned for the stored id must be THIS tenant's, judged BEFORE its status: a foreign
 * subscription's status says nothing about this tenant (a foreign LIVE one would otherwise send the admin to cancel
 * someone else's billing, a foreign terminal one would be a false all-clear). `sub.customer` is an id string or an
 * expanded object; it must equal the tenant's STORED customer id (no stored id = refused, the subscription's
 * customer is never adopted), and `sub.metadata.tenantId`, when present, must equal the tenant id. A missing
 * `sub.customer` fails closed. Nothing is written; one warn names every id involved.
 */
function assertSubscriptionBelongsToTenant(
  deps: StripeGateDeps,
  tenantId: string,
  stripeSubId: string,
  sub: { customer?: unknown; metadata?: { tenantId?: unknown } | null },
  storedCustomerId: string | null,
): void {
  const c = sub.customer;
  const subCustomerId =
    typeof c === "string"
      ? c
      : c && typeof (c as { id?: unknown }).id === "string"
        ? (c as { id: string }).id
        : null;
  const metaTenantId = sub.metadata?.tenantId;
  const metaPresent = typeof metaTenantId === "string" && metaTenantId.length > 0;
  const customerOk = !!storedCustomerId && !!subCustomerId && subCustomerId === storedCustomerId;
  const metaOk = !metaPresent || metaTenantId === tenantId;
  if (customerOk && metaOk) return;
  deps.logger.warn(
    `Tenant ${tenantId}: Stripe subscription ${stripeSubId} owner mismatch; refusing (subscription customer ` +
      `${subCustomerId ?? "none"}, stored customer ${storedCustomerId ?? "none"}` +
      `${metaPresent ? `, subscription metadata tenantId ${String(metaTenantId)}` : ""})`,
  );
  throw stripeSubscriptionOwnerMismatchRefusal(!storedCustomerId);
}

/**
 * M2/M4, the ONE Stripe gate for status -> CANCELLED and tenant delete. Runs BEFORE any transaction (Stripe is
 * never called under the tenant row lock): a plain read of the stored subscription id, then a Stripe read with a
 * short timeout and ONE retry. Returns the id it judged (null = none stored) for the in-transaction compare.
 *  - no stored id: allowed, no Stripe call. A TERMINAL status (`canceled`, `incomplete_expired`): allowed.
 *  - a FOUND subscription must belong to this tenant (customer + metadata.tenantId, see
 *    assertSubscriptionBelongsToTenant) or it is refused STRIPE_SUBSCRIPTION_OWNER_MISMATCH before its status counts.
 *  - a live status is refused (TENANT_CANCEL_SUBSCRIPTION_FIRST) - `paused` and `incomplete` can still come
 *    back, so they are not "ended".
 *  - Stripe unconfigured with a stored id, or a Stripe 401, fails closed as STRIPE_NOT_CONFIGURED.
 *  - a subscription 404 is the same signal as a WRONG Stripe account / mode, so it is only trusted when the
 *    tenant's Stripe CUSTOMER is still there (read the same way): then it is allowed and `notFound` tells the
 *    caller to write the audit row. A customer that is ALSO 404 is refused with STRIPE_ACCOUNT_MISMATCH plus an
 *    ops alert ("key/mode mismatch suspected") and NEVER allowed.
 *  - any other read that fails or times out twice is a retryable 409 (CONCURRENT_UPDATE, reason STRIPE_UNCONFIRMED).
 */
export async function stripeGateBeforeTermination(
  deps: StripeGateDeps,
  id: string,
  adminId: string | null,
): Promise<{ stripeSubId: string | null; notFound: boolean }> {
  const row = await deps.prisma.tenantSubscription.findUnique({
    where: { tenantId: id },
    select: { stripeSubId: true, stripeCustomerId: true },
  });
  const stripeSubId = row?.stripeSubId ?? null;
  if (!stripeSubId) return { stripeSubId: null, notFound: false };
  if (!deps.stripe.isConfigured) throw stripeNotConfiguredRefusal();
  const sub = await readStripeOrMissing(deps, id, `subscription ${stripeSubId}`, () =>
    deps.stripe.getSubscription(stripeSubId),
  );
  if (sub) {
    assertSubscriptionBelongsToTenant(deps, id, stripeSubId, sub, row?.stripeCustomerId ?? null);
    if (!isTerminalStripeSubscriptionStatus(sub.status)) throw cancelSubscriptionFirstRefusal();
    return { stripeSubId, notFound: false };
  }
  const customerId = row?.stripeCustomerId ?? null;
  const customer = customerId
    ? await readStripeOrMissing(deps, id, `customer ${customerId}`, () =>
        deps.stripe.getCustomer(customerId),
      )
    : null;
  if (!customer) {
    await deps.record(id, adminId, AdminAuditAction.STRIPE_KEY_MODE_MISMATCH, {
      message: "Stripe key/mode mismatch suspected",
      stripeSubId,
      stripeCustomerId: customerId,
    });
    throw stripeAccountMismatchRefusal();
  }
  return { stripeSubId, notFound: true };
}
