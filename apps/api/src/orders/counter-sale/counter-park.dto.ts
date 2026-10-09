import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import {
  COUNTER_PARK_LABEL_MAX,
  COUNTER_PARK_MAX_PAGE_SIZE,
  COUNTER_PARK_PAGE_SIZE,
  REGISTER_KEY_PATTERN,
} from "@routeflow/pricing";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/**
 * POST /orders/counter-sale/parked (`ParkCartRequest` of @routeflow/pricing). The `payload` is only checked to be an
 * object here: `sanitizeParkedPayload` rebuilds it from a whitelist in the service, and only the rebuilt copy is stored.
 */
export class ParkCartDto {
  /** minted by the client: a replay of the same park returns the stored row */
  @IsUUID() id: string;
  @IsOptional() @IsString() @Matches(REGISTER_KEY_PATTERN) registerKey?: string;
  @IsOptional() @Transform(trim) @IsString() @MaxLength(COUNTER_PARK_LABEL_MAX) label?: string;
  @IsObject() payload: Record<string, unknown>;
}

/**
 * GET /orders/counter-sale/parked. `register` is NOT pattern-checked here: a missing or invalid register means the
 * default register (the service decides), never a 400.
 */
export class ListParkedDto {
  @IsOptional() @IsString() @MaxLength(200) register?: string;
  @IsOptional() @IsInt() @Min(1) @Type(() => Number) page?: number = 1;
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(COUNTER_PARK_MAX_PAGE_SIZE)
  @Type(() => Number)
  pageSize?: number = COUNTER_PARK_PAGE_SIZE;
}
