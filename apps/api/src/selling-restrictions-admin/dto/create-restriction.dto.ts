import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Transform, Type } from "class-transformer";
import { RestrictionJurisdiction, RestrictionSurface } from "@prisma/client";
import { CreateTargetsDto } from "./rule-targets.dto";

const trim = ({ value }: { value: unknown }) => (typeof value === "string" ? value.trim() : value);

/**
 * The legacy single `categoryId` / `productId` OR (row 509) `targets` with many products and labels. Exactly one of
 * those forms; the service enforces that (and the tenant).
 */
export class CreateRestrictionDto {
  @IsOptional() @IsString() @MaxLength(64) categoryId?: string;
  @IsOptional() @IsString() @MaxLength(64) productId?: string;

  /** Row 509: the products and/or labels the rule covers (1..1,000 ids in all, checked by the service). */
  @IsOptional() @ValidateNested() @Type(() => CreateTargetsDto) targets?: CreateTargetsDto;

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
