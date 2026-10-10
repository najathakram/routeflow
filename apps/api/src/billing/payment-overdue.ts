import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { PrismaService } from "../prisma/prisma.service";
import { billingPauseMode } from "./dunning-config";
import type { StripeService } from "./stripe.service";

/**
 * SA-733r M1 / r2 N1 / r3 N1 (PR-B3): a tenant that owes an overdue invoice cannot buy its way out by changing
 * the plan. `subscribe`, `upgrade`, `downgrade`, `resume` and the Stripe checkout call
 * {@link assertNotPaymentOverdue} first; it answers 409 `PAYMENT_OVERDUE` carrying `hosted_invoice_url`.
 *
 * The check is the OWED MARKER (`pastDueInvoiceId`) plus a Stripe re-read - never the reason text, so it holds after
 * a cancel changes `readOnlyReason`. The re-read FAILS CLOSED: an unreadable Stripe is 409 `PAYMENT_STATE_UNKNOWN`
 * (retryable), never "go ahead". An invoice Stripe now shows paid or void is no longer owed and does not block (the
 * `invoice.paid` webhook clears the marker).
 *
 * `dark` changes nothing a tenant can see: in `off`/`dark` an ACTIVE tenant is never blocked. A tenant that is
 * already READ_ONLY (a pause, or a cancel while paused) is blocked in every mode - the marker is the debt.
 */

type GuardDeps = {
  prisma: Pick<PrismaService, "tenantSubscription" | "tenant">;
  stripe: Pick<StripeService, "getInvoiceFacts">;
  /** Override for a spec; production reads `process.env`. */
  mode?: ReturnType<typeof billingPauseMode>;
};

/** Stripe invoice statuses that still owe money. `uncollectible` stays owed (SA-733r3). */
const OWED_STATUSES = new Set(["open", "uncollectible"]);

export async function assertNotPaymentOverdue(deps: GuardDeps, tenantId: string): Promise<void> {
  const sub = await deps.prisma.tenantSubscription.findUnique({
    where: { tenantId },
    select: { pastDueInvoiceId: true },
  });
  const invoiceId = sub?.pastDueInvoiceId;
  if (!invoiceId) return;

  if ((deps.mode ?? billingPauseMode()) !== "enforced") {
    const tenant = await deps.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    });
    if (tenant?.status === "ACTIVE") return; // dark: a failing payment blocks nothing
  }

  let facts: Awaited<ReturnType<StripeService["getInvoiceFacts"]>>;
  try {
    facts = await deps.stripe.getInvoiceFacts(invoiceId);
  } catch {
    throw new ConflictException({
      code: API_ERROR_CODES.PAYMENT_STATE_UNKNOWN,
      message:
        "We couldn't confirm the status of your open invoice just now. Try again in a moment.",
    });
  }
  const remaining = facts.amountRemaining ?? Math.max(0, facts.amountDue - facts.amountPaid);
  if (!facts.status || !OWED_STATUSES.has(facts.status) || remaining <= 0) return;

  throw new ConflictException({
    code: API_ERROR_CODES.PAYMENT_OVERDUE,
    message: "An invoice on this account is overdue. Pay it to continue.",
    hosted_invoice_url: facts.hostedInvoiceUrl ?? null,
  });
}
