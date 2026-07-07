import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from "class-validator";

export class QuoteAddonDto {
  @ApiProperty({ example: "SEAT_EXTRA" })
  @IsString()
  sku: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity?: number;
}

export class QuoteDto {
  @ApiProperty({ example: "TEAM" })
  @IsString()
  planKey: string;

  @ApiProperty({ enum: ["MONTHLY", "ANNUAL"] })
  @IsIn(["MONTHLY", "ANNUAL"])
  cycle: "MONTHLY" | "ANNUAL";

  @ApiPropertyOptional({ type: [QuoteAddonDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => QuoteAddonDto)
  addons?: QuoteAddonDto[];
}
