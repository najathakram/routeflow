import {
  IsISO8601,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  registerDecorator,
} from "class-validator";
import { Transform } from "class-transformer";
import type { ValidationOptions } from "class-validator";
import { validOpeningFloat, validateDenominations } from "@routeflow/pricing";
import type { DenominationCount } from "@routeflow/types";
import { REGISTER_KEY_PATTERN } from "../day-close/day-close-register";

export const FLOAT_REASON_MIN = 5;
export const FLOAT_REASON_MAX = 500;

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

const IsFloatAmount = () =>
  check("isFloatAmount", "amount must be a whole-cents amount of 0 or more", (v) =>
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
const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/** GET query. */
export class OpeningFloatQueryDto {
  @IsISO8601({ strict: true }) windowStart!: string;
  @IsOptional() @IsRegisterKey() registerKey?: string;
}

/** POST body. byId / tenantId are never fields: they come from the JWT. */
export class RecordOpeningFloatDto {
  @IsISO8601({ strict: true }) windowStart!: string;
  @IsFloatAmount() amount!: number;
  @IsOptional() @IsDenominations() denominations?: DenominationCount[];
  @IsOptional() @IsRegisterKey() registerKey?: string;
}

/** PATCH body (admin). */
export class CorrectOpeningFloatDto {
  @IsISO8601({ strict: true }) windowStart!: string;
  @IsFloatAmount() amount!: number;
  /** The amount the admin's screen showed; a different stored amount is 409 COUNTER_FLOAT_CHANGED. */
  @IsFloatAmount() expectedAmount!: number;
  @Transform(trim)
  @IsString()
  @MinLength(FLOAT_REASON_MIN)
  @MaxLength(FLOAT_REASON_MAX)
  reason!: string;
  @IsOptional() @IsDenominations() denominations?: DenominationCount[];
  @IsOptional() @IsRegisterKey() registerKey?: string;
}
