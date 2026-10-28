import { registerDecorator, ValidationOptions } from "class-validator";
import { TAX_PERCENT_PRECISION_MESSAGE, TAX_RATE_FRACTION_DECIMALS } from "@routeflow/pricing";

/**
 * SA-979: a line / template tax rate is a FRACTION stored as Decimal(9,6). One that carries more than
 * `TAX_RATE_FRACTION_DECIMALS` places is rounded by the column, so the draft was taxed on a value it does not
 * hold (stale from birth, then a 409 on the next edit). Refuse it at the door with the one shared copy.
 *
 * A scaled-integer test, not `maxDecimalPlaces`: that counts the digits of `value.toString()`, which renders 1e-7
 * with no decimal point and so miscounts it. The 1e-6 slack absorbs float noise (0.08875 * 1e6 = 88750.00000000001).
 *
 * Pair with `@IsNumber()`, `@Min(0)` and `@Max(1)`: this owns only the decimal places, and refuses a non-number.
 */
export function isTaxRateFraction(value: unknown): boolean {
  if (typeof value !== "number" || !Number.isFinite(value)) return false;
  const scaled = value * 10 ** TAX_RATE_FRACTION_DECIMALS;
  return Math.abs(scaled - Math.round(scaled)) <= 1e-6;
}

export function IsTaxRateFraction(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isTaxRateFraction",
      target: object.constructor,
      propertyName,
      options: { message: TAX_PERCENT_PRECISION_MESSAGE, ...validationOptions },
      validator: { validate: (value: unknown) => isTaxRateFraction(value) },
    });
  };
}
