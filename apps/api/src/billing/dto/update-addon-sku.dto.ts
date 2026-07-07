import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateIf,
} from "class-validator";

/** Patch an add-on SKU in a DRAFT catalog version. The SKU code, unit and meter are immutable. */
export class UpdateAddonSkuDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monthlyPrice?: number;

  @ApiPropertyOptional({
    description: "planKey at/above which this add-on is bundled free; null = never.",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  includedAtPlan?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  stackable?: boolean;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  grantsFlags?: string[];

  @ApiPropertyOptional({ description: "Meter capacity added per active quantity; null = none." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  capacityPerUnit?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
