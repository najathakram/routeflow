import { ConflictException } from "@nestjs/common";
import { TenantStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * SA-774 r3-r6 (card first, then active): the ONE decision for a self-serve plan operation. A business that
 * pays by card keeps the instant prorated switch; one with no card subscription chooses its plan at Stripe
 * Checkout and the plan changes only when the payment is confirmed. Pure: callers read the facts (including
 * {@link import("./link-pending").isLinkPending}) and act on the outcome.
 */
export type PlanGateOp = "subscribe" | "upgrade" | "downgrade";

export type PlanGateOutcome =
  { kind: "PROCEED" } | { kind: "CHECKOUT" } | { kind: "REFUSE"; code: string };

export interface PlanGateTenant {
  status: string;
  readOnlyReason?: string | null;
}

export interface PlanGateSubscription {
  stripeSubId: string | null;
  externalPayment: boolean;
}

const refuse = (code: string): PlanGateOutcome => ({ kind: "REFUSE", code });

/**
 * Order matters: link-pending first (a payment is already in flight), then manual pay, then the card payer,
 * then everyone else (no card subscription) who is sent to Checkout.
 */
export function selfServePlanGate(
  tenant: PlanGateTenant,
  sub: PlanGateSubscription,
  linkPending: boolean,
  op: PlanGateOp,
): PlanGateOutcome {
  if (linkPending) return refuse(API_ERROR_CODES.CHECKOUT_PAYMENT_PROCESSING);

  if (sub.externalPayment) {
    // An ACTIVE manual-pay tenant may still schedule a downgrade; it pays by catch-up, never by Checkout.
    if (op === "downgrade" && tenant.status === TenantStatus.ACTIVE) return { kind: "PROCEED" };
    return refuse(API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP);
  }

  const cardPayer = tenant.status === TenantStatus.ACTIVE && !!sub.stripeSubId;
  if (cardPayer) {
    return op === "subscribe" ? refuse(API_ERROR_CODES.USE_PLAN_CHANGE) : { kind: "PROCEED" };
  }

  return op === "downgrade"
    ? refuse(API_ERROR_CODES.CHOOSE_PLAN_AT_CHECKOUT)
    : { kind: "CHECKOUT" };
}

/**
 * Has this tenant never been activated by a payment? A trial, a trial that locked (`trial_*`), or a
 * link-pending tenant that is not yet ACTIVE. Used where a sweep or reinstatement must not treat it as a
 * paying customer.
 */
export function isNeverActivated(tenant: PlanGateTenant, linkPending: boolean): boolean {
  if (tenant.status === TenantStatus.TRIAL) return true;
  if (
    tenant.status === TenantStatus.READ_ONLY &&
    (tenant.readOnlyReason ?? "").startsWith("trial_")
  ) {
    return true;
  }
  return linkPending && tenant.status !== TenantStatus.ACTIVE;
}

const REFUSAL_MESSAGE: Record<string, string> = {
  [API_ERROR_CODES.CHECKOUT_PAYMENT_PROCESSING]:
    "Your card payment is still being confirmed. This change is available once it clears.",
  [API_ERROR_CODES.EXTERNAL_PAYMENT_USE_CATCHUP]:
    "Your account is invoiced directly. Card setup is completed through your RouteFlow contact - they will send you a secure payment link.",
  [API_ERROR_CODES.USE_PLAN_CHANGE]:
    "Your plan is paid by card. Use Change plan to switch; the new price is prorated.",
  [API_ERROR_CODES.CHOOSE_PLAN_AT_CHECKOUT]:
    "Choose your plan at checkout. Your plan starts once your payment clears.",
};

/** The coded 409 for a refused self-serve plan operation (shape of `admin-lock-refusal.ts`). */
export function planGateRefusal(code: string): ConflictException {
  return new ConflictException({
    code,
    message: REFUSAL_MESSAGE[code] ?? "This plan change is not available.",
  });
}
