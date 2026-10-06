import { registerDecorator, ValidationArguments, ValidationOptions } from "class-validator";
import { isWholeCents } from "@routeflow/pricing";

/**
 * B1120: a money field backed by a numeric(10,2) column must arrive in WHOLE CENTS. Defined by
 * `isWholeCents` (@routeflow/pricing), the ONE predicate for "is this a cents amount", so it agrees with
 * every `roundMoney` write: 19.99 and 1.1 pass, 8.355, 0.001 and 1e-7 are refused. class-validator's own
 * `maxDecimalPlaces` counts the digits of `value.toString()`, which a tiny value renders as "1e-7" with no
 * decimal point, so it is not the guard for a money field.
 *
 * Pair it with `@IsNumber()` (finite, a real number) and the sign/size bounds (`@Min(0)`,
 * `@Max(MAX_DECIMAL_10_2)`): this decorator owns only the decimal places, and it refuses a non-number too.
 */
export function IsWholeCents(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string) {
    registerDecorator({
      name: "isWholeCents",
      target: object.constructor,
      propertyName,
      options: {
        message: (args: ValidationArguments) =>
          `${args.property} must be a whole-cent amount (at most 2 decimal places)`,
        ...validationOptions,
      },
      validator: {
        validate: (value: unknown) => typeof value === "number" && isWholeCents(value),
      },
    });
  };
}
