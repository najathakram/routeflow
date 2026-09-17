import { BadRequestException } from "@nestjs/common";
import {
  assertMoneyInvariants,
  MoneyInvariantError,
  type MoneyInvariantInput,
} from "@routeflow/pricing";

/**
 * HTTP-layer wrapper around `@routeflow/pricing`'s `assertMoneyInvariants`
 * (B451 gap 4): every call site gets the SAME structured 400 — never an
 * unhandled `MoneyInvariantError` falling through to the Sentry catch-all
 * filter as a 500.
 */
export function assertMoneyInvariantsOrThrow(input: MoneyInvariantInput): void {
  try {
    assertMoneyInvariants(input);
  } catch (err) {
    if (err instanceof MoneyInvariantError) {
      throw new BadRequestException({ code: "MONEY_INVARIANT", message: err.message });
    }
    throw err;
  }
}
