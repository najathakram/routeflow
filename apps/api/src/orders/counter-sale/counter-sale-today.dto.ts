import { IsInt, IsOptional, IsString, Max, Min, registerDecorator } from "class-validator";
import type { ValidationOptions } from "class-validator";
import { Type } from "class-transformer";
import { parseCalendarDay } from "../../common/calendar-date";
import { TODAYS_SALES_DEFAULT_LIMIT, TODAYS_SALES_MAX_LIMIT } from "./counter-sale-today";

/** `value` names a REAL calendar day: strict "YYYY-MM-DD" (2026-02-30 and 2026-13-01 are refused, not rolled over). */
function IsCalendarDay(options?: ValidationOptions) {
  return (target: object, propertyName: string) =>
    registerDecorator({
      name: "isCalendarDay",
      target: target.constructor,
      propertyName,
      options: {
        message: "day must be a real calendar day (YYYY-MM-DD)",
        ...options,
      },
      validator: {
        validate: (value: unknown) => typeof value === "string" && parseCalendarDay(value) !== null,
      },
    });
}

/**
 * GET /orders/counter-sale/today query. `day` is optional (default: today in the tenant's zone, computed
 * server-side); a day AFTER the tenant's today is refused by the service (it needs the tenant's zone).
 * `limit` stops at 100: a till page, far below the shared MAX_LIST_LIMIT.
 */
export class CounterSaleTodayDto {
  @IsOptional() @IsString() @IsCalendarDay() day?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(TODAYS_SALES_MAX_LIMIT)
  @Type(() => Number)
  limit?: number = TODAYS_SALES_DEFAULT_LIMIT;
}
