import { BadRequestException } from "@nestjs/common";
import { roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { parseCalendarDay } from "../../common/calendar-date";

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
  /** CHECK only: the date written on the check, YYYY-MM-DD (the DTO pins the shape). */
  checkDate?: string;
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
