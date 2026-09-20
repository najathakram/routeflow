import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator";
import { Transform } from "class-transformer";
import { RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/** Exactly one of categoryId / productId; the service enforces that (and the tenant). */
export class CreateRestrictionDto {
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;
  @IsOptional() @IsString() @MaxLength(64) productId?: string;

  @IsEnum(RestrictionJurisdiction) jurisdiction: RestrictionJurisdiction;

  /** USPS codes or full state names; required (non-empty) for STATE, must be absent/empty for FEDERAL. */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(60)
  @IsString({ each: true })
  @MaxLength(40, { each: true })
  states?: string[];

  @IsOptional() @IsEnum(RestrictionSurface) surface?: RestrictionSurface;
  @IsOptional() @IsDateString() effectiveFrom?: string;
  @IsOptional() @IsDateString() effectiveTo?: string;

  @Transform(trim) @IsString() @MinLength(1) @MaxLength(500) reason: string;
}
