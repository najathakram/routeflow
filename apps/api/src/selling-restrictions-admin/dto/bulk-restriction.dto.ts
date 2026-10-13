import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";
import type { BULK_RESTRICTION_MAX_PRODUCTS } from "@routeflow/types";

/**
 * The API-side copy of the shared `BULK_RESTRICTION_MAX_PRODUCTS` (the API never imports
 * `@routeflow/types` at runtime). Typed as the shared constant's literal type, so a change to the
 * shared cap fails to compile here until this copy follows it.
 */
export const BULK_RESTRICTION_MAX: typeof BULK_RESTRICTION_MAX_PRODUCTS = 200;

/** A blank optional note means "use the default", never an empty stored reason. */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== "string") return value;
  const t = value.trim();
  return t === "" ? undefined : t;
};

/**
 * POST /selling-restrictions/bulk (wire shape `BulkRestrictionRequest`). Exactly one of
 * productIds / categoryId; the service enforces that, the states rules and the tenant, through the
 * same path single create uses.
 */
export class BulkRestrictionDto {
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_RESTRICTION_MAX, {
    message: `Send at most ${BULK_RESTRICTION_MAX} products at once, or limit a whole category instead.`,
  })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  productIds?: string[];

  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;

  @IsEnum(RestrictionJurisdiction) jurisdiction: RestrictionJurisdiction;

  /** USPS codes or full state names; required (non-empty) for STATE, must be absent/empty for FEDERAL. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  states?: string[];

  /** Defaults to BUYER_PORTAL here (single create defaults to ALL). */
  @IsOptional() @IsEnum(RestrictionSurface) surface?: RestrictionSurface;

  /** Defaults to "Portal limit". */
  @IsOptional() @Transform(trimToUndefined) @IsString() @MaxLength(500) reason?: string;

  @IsOptional() @IsDateString() effectiveFrom?: string;
  @IsOptional() @IsDateString() effectiveTo?: string;
}

/** POST /selling-restrictions/lift-batch (wire shape `LiftBatchRequest`). */
export class LiftBatchDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(BULK_RESTRICTION_MAX, {
    message: `Lift at most ${BULK_RESTRICTION_MAX} limits at once.`,
  })
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  ids: string[];

  /** Defaults to "Limit lifted". */
  @IsOptional() @Transform(trimToUndefined) @IsString() @MaxLength(500) reason?: string;
}
