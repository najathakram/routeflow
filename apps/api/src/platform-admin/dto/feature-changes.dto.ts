import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { FeatureOverrideKind } from "@prisma/client";

/** Literals, not a value import from @routeflow/types (L-151: it would crash the API's production boot). */
export const FEATURE_CHANGE_TYPES = ["override"] as const;
export const FEATURE_CHANGE_ACTIONS = ["GRANT", "DENY", "CLEAR"] as const;
/** One saved set holds at most this many changes (R27, the sheet lists them all). */
export const FEATURE_CHANGE_SET_CAP = 50;

export class FeatureChangeDto {
  @ApiPropertyOptional({
    enum: FEATURE_CHANGE_TYPES,
    description:
      "What kind of change this is. Only an override today; the shape leaves room for another kind (a comp add-on) without a rewrite.",
  })
  @IsOptional()
  @IsIn(FEATURE_CHANGE_TYPES)
  type?: (typeof FEATURE_CHANGE_TYPES)[number];

  @ApiProperty({ example: "tobacco_dealer" })
  @IsString()
  @MinLength(2)
  @MaxLength(64)
  key: string;

  @ApiProperty({ enum: FEATURE_CHANGE_ACTIONS, description: "CLEAR removes the live override." })
  @IsIn(FEATURE_CHANGE_ACTIONS)
  action: (typeof FEATURE_CHANGE_ACTIONS)[number];

  @ApiPropertyOptional({ enum: FeatureOverrideKind })
  @IsOptional()
  @IsEnum(FeatureOverrideKind)
  kind?: FeatureOverrideKind;

  @ApiPropertyOptional({
    description: "ISO date the override stops applying; omit for a standing one",
  })
  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}

export class ApplyFeatureChangesDto {
  @ApiProperty({
    description:
      "The inputsHash the page read. A different current hash refuses the whole save (409).",
  })
  @IsString()
  @MinLength(8)
  @MaxLength(64)
  expected: string;

  @ApiProperty({ description: "Why, shown in History", example: "Pilot: waived while onboarding" })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;

  @ApiProperty({ type: [FeatureChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(FEATURE_CHANGE_SET_CAP)
  @ValidateNested({ each: true })
  @Type(() => FeatureChangeDto)
  changes: FeatureChangeDto[];

  @ApiPropertyOptional({
    description: "Check the set and return before/after per key; writes nothing.",
  })
  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;
}

export class UndoFeatureChangesDto {
  @ApiProperty({ description: "Why the set is being undone, shown in History" })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
