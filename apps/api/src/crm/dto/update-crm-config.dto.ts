import { IsBoolean, IsEnum, IsISO8601, IsOptional, IsString, Matches } from "class-validator";
import { CrmTriggerMode } from "@prisma/client";

/** `PATCH /crm/gohighlevel/config` request shape (spec R4). */
export class UpdateCrmConfigDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsBoolean()
  dryRun?: boolean;

  @IsOptional()
  @IsEnum(CrmTriggerMode)
  triggerMode?: CrmTriggerMode;

  @IsOptional()
  @IsString()
  pipelineId?: string;

  @IsOptional()
  @IsString()
  stageId?: string;

  @IsOptional()
  @IsString()
  stageName?: string;

  @IsOptional()
  @IsISO8601()
  startFrom?: string;

  @IsOptional()
  @IsBoolean()
  writeBackFields?: boolean;

  @IsOptional()
  @IsBoolean()
  writeBackTag?: boolean;

  @IsOptional()
  @IsBoolean()
  writeBackNote?: boolean;

  @IsOptional()
  @IsBoolean()
  markWon?: boolean;

  /** ISO-3166 alpha-2 (e.g. "US"). */
  @IsOptional()
  @Matches(/^[A-Z]{2}$/)
  defaultRegion?: string;
}
