import { ConflictException, type Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";
import {
  billingPauseMode,
  type BillingPauseMode,
  PAYMENT_OVERDUE_REASON,
  READ_ONLY_STATUS,
  SUBSCRIPTION_CANCELLED_REASON,
} from "./dunning-config";
import { isOwed } from "./dunning-core";
import type { StripeService } from "./stripe.service";

/**
 * SA-733r M1 / r2 N1 / r3 N1 + the SA-733r7 r-note (1): a tenant that owes an overdue invoice cannot buy its way out
 * by changing the plan. ONE helper, {@link assertNotPaymentOverdue}, is called by EVERY plan-mutation entry point
 * (the closed list in {@link OVERDUE_ENTRY_POINTS}, pinned by `dunning-structural.spec.ts`):
 * subscribe / upgrade / downgrade / resume / checkout and the B1 admin plan change. It answers 409 `PAYMENT_OVERDUE`
 * carrying `hosted_invoice_url`.
 *
 * WHEN IT REFUSES (the owed MARKER `pastDueInvoiceId` plus a Stripe re-read of an OPEN invoice with money remaining;
 * `uncollectible` is the owner's write-off and is never owed):
 *   - READ_ONLY with reason `payment_overdue`, or `subscription_cancelled` with the owed marker: in every mode;
 *   - anything else (ACTIVE, TRIAL, a lapsed trial's READ_ONLY...): only in `enforced`. In `dark` the call is ALLOWED and a structured
 *     `billing.dunning.would_refuse code=PAYMENT_OVERDUE tenant=<id> entryPoint=<name>` warn is logged (the dark gate
 *     pattern), so the blast-radius report can count what `enforced` would refuse. `dark` is behaviour-neutral.
 *   - `off`: an ACTIVE tenant is never touched (no Stripe read, no log).
 *
 * The re-read FAILS CLOSED wherever it would refuse: an unreadable Stripe is 409 `PAYMENT_STATE_UNKNOWN` (retryable),
 * never "go ahead". An invoice Stripe now shows paid or void is no longer owed (the `invoice.paid` webhook clears
 * the marker).
 */

/** The closed list of entry points that call the helper. */
export const OVERDUE_ENTRY_POINTS = [
  "subscribe",
  "upgrade",
  "downgrade",
  "resume",
  "checkout",
  "admin_plan_change",
] as const;
export type OverdueEntryPoint = (typeof OVERDUE_ENTRY_POINTS)[number];

interface GuardCtx {
  stripe: Pick<StripeService, "getInvoiceFacts">;
  logger: Pick<Logger, "warn">;
}

export async function assertNotPaymentOverdue(
  ctx: GuardCtx,
  tenant: { id: string; status: string; readOnlyReason?: string | null },
  sub: { pastDueInvoiceId?: string | null } | null | undefined,
  mode: BillingPauseMode,
  entryPoint: OverdueEntryPoint,
): Promise<void> {
  const invoiceId = sub?.pastDueInvoiceId;
  if (!invoiceId) return;

  // A pause, or a cancel while paused (READ_ONLY with payment_overdue / subscription_cancelled): the marker is the
  // debt - refused in every mode. Every other state (ACTIVE, TRIAL, a lapsed trial's READ_ONLY...) follows the
  // enforced-only rule, so `dark` stays behaviour-neutral for tenants the pause never touched.
  const inDebtState =
    tenant.status === READ_ONLY_STATUS &&
    (tenant.readOnlyReason === PAYMENT_OVERDUE_REASON ||
      tenant.readOnlyReason === SUBSCRIPTION_CANCELLED_REASON);
  const refuseNow = inDebtState || mode === "enforced";
  if (!refuseNow && mode === "off") return;

  let facts: Awaited<ReturnType<StripeService["getInvoiceFacts"]>>;
  try {
    facts = await ctx.stripe.getInvoiceFacts(invoiceId);
  } catch {
    if (!refuseNow) return; // dark: nothing is enforced, so an unreadable Stripe changes nothing
    throw new ConflictException({
      code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN,
      message:
        "We couldn't confirm the status of your open invoice just now. Try again in a moment.",
    });
  }
  // owed = status open with money remaining, nothing else (SA-733r M2, r7 r-note 2): ONE definition, in dunning-core
  if (!isOwed(facts)) return;

  if (!refuseNow) {
    ctx.logger.warn(
      `billing.dunning.would_refuse code=${API_ERROR_CODES.PAYMENT_OVERDUE} tenant=${tenant.id} entryPoint=${entryPoint} invoice=${invoiceId}`,
    );
    return;
  }
  throw new ConflictException({
    code: API_ERROR_CODES.PAYMENT_OVERDUE,
    message: "An invoice on this account is overdue. Pay it to continue.",
    hosted_invoice_url: facts.hostedInvoiceUrl ?? null,
  });
}

/**
 * What every entry point calls: loads the owed marker (one cheap read) and, only when there is one, the tenant, then
 * runs {@link assertNotPaymentOverdue}. `mode` is injectable for a spec; production reads `BILLING_PAUSE_MODE`.
 */
export async function assertTenantNotPaymentOverdue(
  deps: GuardCtx & { prisma: Pick<PrismaService, "tenantSubscription" | "tenant"> },
  tenantId: string,
  entryPoint: OverdueEntryPoint,
  mode: BillingPauseMode = billingPauseMode(),
): Promise<void> {
  const sub = await deps.prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: { pastDueInvoiceId: true },
  });
  if (!sub?.pastDueInvoiceId) return;
  const tenant = await deps.prisma.tenant.findUnique({
    where: { id: tenantId },
    select: { id: true, status: true, readOnlyReason: true },
  });
  if (!tenant) return; // the caller 404s
  await assertNotPaymentOverdue(
    deps,
    { id: tenantId, status: tenant.status, readOnlyReason: tenant.readOnlyReason },
    sub,
    mode,
    entryPoint,
  );
}
