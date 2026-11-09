import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from "class-validator";

/** SA-1122 (i): the change a catch-up correction asks for (preview and apply share it). */
export class CatchupCorrectionPreviewDto {
  @ApiPropertyOptional({ description: "Activation marker ids whose window is NOT paid coverage." })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  voidCoverage?: string[];

  @ApiPropertyOptional({ description: "Activation marker ids to count as paid coverage again." })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  @MaxLength(64, { each: true })
  restoreCoverage?: string[];

  @ApiPropertyOptional({
    description: "The 1st of a month (YYYY-MM-DD, read as 12:00Z), not before go-live.",
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  billingStart?: string;
}

export class CatchupCorrectionApplyDto extends CatchupCorrectionPreviewDto {
  @ApiProperty({
    description: "Why, trimmed, 10 to 500 characters (the server enforces the range).",
  })
  @IsString()
  @MaxLength(2000)
  reason!: string;

  @ApiProperty({
    nullable: true,
    description:
      "The BEFORE catch-up line (cents) the screen showed; null when it showed none. 409 CATCHUP_PREVIEW_STALE when the server's differs.",
  })
  @ValidateIf((o: CatchupCorrectionApplyDto) => o.expectedBefore !== null)
  @IsInt()
  @Min(0)
  @Max(100_000_00)
  expectedBefore!: number | null;

  @ApiProperty({ description: "The tenant's name, typed back." })
  @IsString()
  @MaxLength(200)
  confirmTenantName!: string;
}
