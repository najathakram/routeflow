import { Transform } from "class-transformer";
import { IsString, MaxLength, MinLength } from "class-validator";

/** C0 and C1 control characters (and DEL): never part of a typed reason. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

/** The reason as stored: control characters stripped, then trimmed (so " ab\n" is 2 characters, not 4). */
export function cleanVoidReason(value: unknown): unknown {
  return typeof value === "string" ? value.replace(CONTROL_CHARS, "").trim() : value;
}

/** `CounterSaleVoidRequest` of the shared contract (packages/types/api/counter-sale.ts). */
export class CounterSaleVoidDto {
  @Transform(({ value }) => cleanVoidReason(value))
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;
}
