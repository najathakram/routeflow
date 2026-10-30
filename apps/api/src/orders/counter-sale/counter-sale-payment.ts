import { BadRequestException } from "@nestjs/common";
import { clearedTenderNow, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { parseCalendarDay, tenantTodayDay } from "../../common/calendar-date";
import { resolveZone } from "../../common/tenant-time-zone";
import type { ToCollectMethod } from "../../invoices/to-collect";

/**
 * Counter sale payment rules. Two stages, because the sale's total is computed by create() (tax,
 * tiers, overrides) and is not known until it commits:
 *  - `assertPaymentShape`: what can be judged from the request alone. Runs BEFORE anything is written.
 *  - `planCounterPayment`: the tender decision against the server's POST-send invoice balance. Runs
 *    after the sale commits; a refusal there leaves the sale as an open invoice on account.
 * No line/tax/total math lives here: only the payment split, in cents via roundMoney.
 */
export type CounterPaymentMethod = "CASH" | "CARD" | "CHECK" | "ON_ACCOUNT";

export interface CounterPaymentInput {
  method: CounterPaymentMethod;
  amount?: number;
  reference?: string;
  recordAnyway?: boolean;
  /** CHECK only: the date written on the check, YYYY-MM-DD (the DTO pins the shape). */
  checkDate?: string;
  /**
   * SA-1026: "the check is not in hand yet". Only with ON_ACCOUNT (a named customer): no payment row, the invoice is marked
   * To collect. Judged in `assertPaymentShape`, the one shape guard the till and the hand-over share.
   */
  expectedMethod?: ToCollectMethod;
}

const refuse = (code: string, message: string) => new BadRequestException({ code, message });

export function assertPaymentShape(payment: CounterPaymentInput, walkIn: boolean): void {
  if (payment.amount != null && (!Number.isFinite(payment.amount) || payment.amount < 0)) {
    throw new BadRequestException("Payment amount must be zero or more");
  }
  if (payment.method === "ON_ACCOUNT" && walkIn) {
    throw refuse(
      API_ERROR_CODES.WALK_IN_NO_ACCOUNT,
      "A walk-in customer has no account — take a payment or pick a customer",
    );
  }
  // SA-1026: the intent rides only beside On account (a check IN hand is a CHECK tender with its number).
  if (payment.expectedMethod != null && payment.method !== "ON_ACCOUNT") {
    throw refuse(
      API_ERROR_CODES.COUNTER_EXPECTED_METHOD_NEEDS_ON_ACCOUNT,
      "Choose On account to save the sale until the check arrives",
    );
  }
  if (payment.method === "CHECK" && !payment.reference?.trim()) {
    throw refuse(API_ERROR_CODES.COUNTER_CHECK_NUMBER_REQUIRED, "Enter the check number");
  }
}

/**
 * Interim till guard (owner P0): a CHECK dated after the TENANT's today is never tendered at the till, because a post-dated
 * check is not money yet. Refused 400 COUNTER_CHECK_POSTDATED before anything is written. `today` is the tenant's calendar day
 * ("YYYY-MM-DD", from the tenant's zone, never the server's); YYYY-MM-DD strings order like the days they name. No date, today
 * or earlier, and every other method pass. A date that names no real day is a plain 400.
 */
export function assertCheckNotPostdated(payment: CounterPaymentInput, today: string): void {
  if (payment.method !== "CHECK" || payment.checkDate == null) return;
  if (!parseCalendarDay(payment.checkDate)) {
    throw new BadRequestException("checkDate must be a real calendar day (YYYY-MM-DD)");
  }
  if (payment.checkDate > today) {
    throw refuse(
      API_ERROR_CODES.COUNTER_CHECK_POSTDATED,
      "Post-dated check: put this sale on account and record the check when it clears.",
    );
  }
}

/**
 * The tender paths' one call: resolves the TENANT's zone (one read, and only when a CHECK states a date), takes its calendar
 * day at `now`, and applies `assertCheckNotPostdated`. The counter sale and the pickup hand-over both run it before any write.
 */
export async function assertCheckNotPostdatedForTenant(
  prisma: Parameters<typeof resolveZone>[0] & { getTenantId(): string | null | undefined },
  payment: CounterPaymentInput,
  now: Date = new Date(),
): Promise<void> {
  if (payment.method !== "CHECK" || payment.checkDate == null) return;
  const { zone } = await resolveZone(prisma, { tenantId: prisma.getTenantId() ?? "" });
  assertCheckNotPostdated(payment, tenantTodayDay(zone, now));
}

/**
 * B1209: a walk-in has no account, so a stated tender below the SERVER total is refused (400 COUNTER_TENDER_SHORT, the status pickup-complete uses for the same code)
 * before anything is written. `total` is create()'s own, handed over through `beforeWrite`. An omitted amount is the
 * exact balance; ON_ACCOUNT takes no money (assertPaymentShape already refuses it for a walk-in).
 */
export function assertWalkInTenderCoversTotal(payment: CounterPaymentInput, total: number): void {
  if (payment.method === "ON_ACCOUNT" || payment.amount == null) return;
  if (roundMoney(payment.amount) < roundMoney(total)) {
    throw new BadRequestException({
      code: API_ERROR_CODES.COUNTER_TENDER_SHORT,
      message: "A walk-in customer must pay the full balance",
    });
  }
}

/** The Prisma `PaymentMethod` for a counter method; ON_ACCOUNT is not a payment (null). */
export function toPrismaMethod(
  method: CounterPaymentMethod,
): "CASH" | "CREDIT_CARD" | "CHECK" | null {
  if (method === "CASH") return "CASH";
  if (method === "CARD") return "CREDIT_CARD";
  if (method === "CHECK") return "CHECK";
  return null;
}

export type CounterPaymentPlan =
  | { kind: "none" }
  | { kind: "pay"; amount: number; tendered: number }
  | { kind: "refuse"; code: string };

export function planCounterPayment(input: {
  method: CounterPaymentMethod;
  amount?: number;
  balance: number;
}): CounterPaymentPlan {
  const balance = roundMoney(input.balance);
  if (input.method === "ON_ACCOUNT" || balance <= 0) return { kind: "none" };
  const tendered = roundMoney(input.amount ?? balance);
  if (tendered <= 0) return { kind: "refuse", code: API_ERROR_CODES.COUNTER_TENDER_SHORT };
  // Cash may exceed the balance (the till gives change); a card or check cannot be charged over it.
  if (tendered > balance && input.method !== "CASH") {
    return { kind: "refuse", code: API_ERROR_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL };
  }
  // Below the balance is a PARTIAL payment of exactly what was tendered (no change); the rest stays open.
  return { kind: "pay", amount: Math.min(tendered, balance), tendered };
}

/** Spread one payment over a mixed regulated order's sibling invoices, oldest first. */
export function allocateOldestFirst(
  invoices: { id: string; balance: number }[],
  amount: number,
): { invoiceId: string; amount: number }[] {
  const out: { invoiceId: string; amount: number }[] = [];
  let left = roundMoney(amount);
  for (const inv of invoices) {
    if (left <= 0) break;
    const part = roundMoney(Math.min(left, inv.balance));
    if (part <= 0) continue;
    out.push({ invoiceId: inv.id, amount: part });
    left = roundMoney(left - part);
  }
  return out;
}

/**
 * S1 (C42): how much of the server `total` this request pays at the till, for the credit gate. The ONE
 * pricing helper does the cents math. Counter facts: a CARD or CHECK is never charged over the balance
 * (`planCounterPayment` refuses it, no money is taken), so such a request clears nothing; and a CHECK
 * dated after the tenant's `today` (a post-dated check) is not money yet, so it counts 0. A CHECK with
 * no date, or dated today or earlier, counts like cash.
 */
export function counterCreditPaidNow(
  payment: CounterPaymentInput,
  total: number,
  today?: string,
): number {
  if (
    payment.method !== "CASH" &&
    payment.amount != null &&
    roundMoney(payment.amount) > roundMoney(total)
  ) {
    return 0;
  }
  const pending =
    payment.method === "CHECK" &&
    !!payment.checkDate &&
    !!today &&
    payment.checkDate.slice(0, 10) > today;
  return clearedTenderNow([{ ...payment, pending }], total);
}
