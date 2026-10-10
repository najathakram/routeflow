import { IsOptional, IsString, MaxLength, registerDecorator } from "class-validator";
import type { ValidationOptions } from "class-validator";
import {
  DAY_CLOSE_NOTES_MAX,
  validOpeningFloat,
  validateDenominations,
  type DenominationCount,
} from "@routeflow/pricing";
import { REGISTER_KEY_PATTERN } from "./day-close-register";

const check = (
  name: string,
  message: string,
  ok: (v: unknown) => boolean,
  options?: ValidationOptions,
) => {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name,
      target: target.constructor,
      propertyName,
      options: { message, ...options },
      validator: { validate: (value: unknown) => ok(value) },
    });
};

const IsOpeningFloat = () =>
  check("isOpeningFloat", "openingFloat must be a whole-cents amount of 0 or more", (v) =>
    validOpeningFloat(v),
  );
const IsDenominations = () =>
  check(
    "isDenominations",
    "denominations must list each bill or coin once with a whole count of 0 to 100000",
    (v) => validateDenominations(v) !== null,
  );
const IsRegisterKey = () =>
  check(
    "isRegisterKey",
    "registerKey must be 1-64 letters, digits, '_', '-' or ':'",
    (v) => typeof v === "string" && REGISTER_KEY_PATTERN.test(v),
  );

/** GET /orders/counter-sale/day-close query. */
export class DayCloseQueryDto {
  @IsOptional() @IsRegisterKey() registerKey?: string;
}

/**
 * POST /orders/counter-sale/day-close body. A client `counted` / `expected` is not a field: the global pipe refuses the unknown
 * property, and the server recomputes both anyway.
 */
export class DayCloseDto {
  @IsOpeningFloat() openingFloat!: number;
  @IsDenominations() denominations!: DenominationCount[];
  @IsOptional() @IsString() @MaxLength(DAY_CLOSE_NOTES_MAX) notes?: string;
  @IsOptional() @IsRegisterKey() registerKey?: string;
}
