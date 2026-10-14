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
import { QuoteAddonDto } from "./quote.dto";

export class SubscribeDto {
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

export class UpgradeDto {
  @ApiProperty({ example: "BUSINESS" })
  @IsString()
  planKey: string;
}

export class DowngradeDto {
  @ApiProperty({ example: "STARTER" })
  @IsString()
  targetPlanKey: string;

  @ApiPropertyOptional({ type: [String], description: "Users to keep active when seats shrink." })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  retainedUserIds?: string[];
}

export class EnableAddonDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  quantity?: number;

  @ApiPropertyOptional({
    description:
      "The quantity the caller saw (0 = not on). `quantity` is the TARGET total, so a mismatch with the stored " +
      "quantity is a 409 ADDON_QUANTITY_CHANGED before anything is billed; a target at or below it is " +
      "ADDON_QUANTITY_NOT_INCREASED. Omit for the legacy set-the-total behaviour.",
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  expectedQuantity?: number;
}
