import { IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { Transform } from "class-transformer";
import { LabelMode } from "@prisma/client";

export class SetProductLabelDto {
  @IsEnum(LabelMode) mode: LabelMode;

  /** Required (non-blank) when mode = EXCLUDE — enforced in the service. */
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(500)
  reason?: string;
}
