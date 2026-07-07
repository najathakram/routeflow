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

/** Patch a plan definition in a DRAFT catalog version. All fields optional. */
export class UpdatePlanDefinitionDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ description: "Monthly price; null = custom (Enterprise)." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  monthlyPrice?: number | null;

  @ApiPropertyOptional({ description: "Annual price; omit to auto-fill monthly×10." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  annualPrice?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isCustom?: boolean;

  @ApiPropertyOptional({ description: "Seats included; null = unlimited." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  seatsIncluded?: number | null;

  @ApiPropertyOptional({ description: "Concurrent routes/day; null = unlimited." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  routesConcurrent?: number | null;

  @ApiPropertyOptional({ description: "Scans/cycle; null = unlimited." })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsInt()
  @Min(0)
  scansIncluded?: number | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  msgsIncluded?: number;

  @ApiPropertyOptional({ type: [String], description: "Granted feature-flag keys." })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  featureFlags?: string[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  sortOrder?: number;
}
