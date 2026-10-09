import { BadRequestException } from "@nestjs/common";
import {
  TENDER_RULES,
  dollarsToCents,
  isWholeCents,
  roundMoney,
  type TenderMethod,
} from "@routeflow/pricing";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { assertPaymentShape, type CounterPaymentInput } from "./counter-sale-payment";

/**
 * Split-payment request rules for POST /orders/counter-sale, read from TENDER_RULES.counter (never a second
 * copy of a limit). Two stages, both BEFORE anything is written:
 *  - `assertLegsShape`: what the request alone decides;
 *  - `assertLegsAgainstTotal`: what needs the SERVER total (create() hands it over through `beforeWrite`).
 * The old single `payment` is a one-leg alias: it goes through the same rules. Amounts arrive in dollars and
 * are judged in integer cents (pricing's dollarsToCents); no line/tax/total math lives here.
 */
const RULE = TENDER_RULES.counter;

export interface CounterLegInput {
  method: TenderMethod;
  amount?: number;
  reference?: string;
}

const refuse = (code: string, message: string) => new BadRequestException({ code, message });

/** The request's legs: exactly one of `payment` (one-leg alias) or `payments`. */
export function resolveLegs(body: {
  payment?: CounterLegInput;
  payments?: CounterLegInput[];
}): CounterLegInput[] {
  const { payment, payments } = body;
  if (payment != null && payments != null) {
    throw refuse(
      API_ERROR_CODES.COUNTER_PAYMENT_SHAPE_CONFLICT,
      "Send either payment or payments, not both",
    );
  }
  if (payment != null) return [payment];
  if (payments != null) return payments;
  throw refuse(API_ERROR_CODES.COUNTER_PAYMENT_SHAPE_CONFLICT, "Send a payment");
}

/** What the request alone decides. Throws a coded 400. */
export function assertLegsShape(legs: readonly CounterLegInput[], walkIn: boolean): void {
  if (legs.length > RULE.maxLegs) {
    throw refuse(
      API_ERROR_CODES.COUNTER_TOO_MANY_LEGS,
      `A sale can be split over at most ${RULE.maxLegs} payments`,
    );
  }
  if (legs.some((l) => !RULE.allowed.includes(l.method))) {
    throw refuse(
      API_ERROR_CODES.TENDER_METHOD_NOT_ALLOWED,
      "That payment method cannot be taken at the counter",
    );
  }
  if (legs.length > 1 && legs.some((l) => RULE.singleLegOnly.includes(l.method))) {
    throw refuse(
      API_ERROR_CODES.COUNTER_ON_ACCOUNT_NOT_SPLIT,
      "Leaving the sale on account cannot be one part of a split payment",
    );
  }
  if (legs.filter((l) => l.method === "CASH").length > RULE.maxCashLegs) {
    throw refuse(API_ERROR_CODES.COUNTER_DUPLICATE_CASH_LEG, "Only one part can be cash");
  }
  for (const leg of legs) {
    assertPaymentShape(leg as CounterPaymentInput, walkIn);
    if (leg.amount != null && !isWholeCents(leg.amount)) {
      throw refuse(API_ERROR_CODES.COUNTER_LEG_NOT_CENTS, "Amounts must be whole cents");
    }
  }
  if (legs.length > 1 && legs.some((l) => l.amount == null || !(l.amount > 0))) {
    throw refuse(
      API_ERROR_CODES.COUNTER_LEG_AMOUNT_REQUIRED,
      "Every part of a split payment needs an amount above zero",
    );
  }
}

/**
 * What needs the server total (before anything is written). An omitted amount (one-leg only) is the exact
 * total. A non-cash part may never exceed what is owed; a cash part may not be added once non-cash parts
 * already cover it; a walk-in has no account, so the parts must add up to at least the total.
 */
export function assertLegsAgainstTotal(
  legs: readonly CounterLegInput[],
  total: number,
  walkIn: boolean,
): void {
  if (legs.length === 1 && legs[0].method === "ON_ACCOUNT") return;
  const totalCents = dollarsToCents(roundMoney(total));
  const cents = legs.map((l) => (l.amount == null ? totalCents : dollarsToCents(l.amount)));
  const nonCash = legs.reduce((sum, l, i) => (l.method === "CASH" ? sum : sum + cents[i]), 0);
  const hasCash = legs.some((l) => l.method === "CASH");
  if (nonCash > totalCents || (legs.length > 1 && hasCash && nonCash >= totalCents)) {
    throw refuse(
      API_ERROR_CODES.COUNTER_PAYMENT_EXCEEDS_TOTAL,
      "The payments add up to more than the sale total",
    );
  }
  if (walkIn && cents.reduce((a, b) => a + b, 0) < totalCents) {
    throw refuse(
      API_ERROR_CODES.COUNTER_TENDER_SHORT,
      "A walk-in customer must pay the full balance",
    );
  }
}
