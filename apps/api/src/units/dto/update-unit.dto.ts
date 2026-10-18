import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";
import { UNIT_NAME_EMPTY, UNIT_NAME_TOO_LONG } from "./create-unit.dto";

/** Rename and archive are separate calls: send `name` OR `archived`, never both. */
export class UpdateUnitDto {
  @IsOptional()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString({ message: UNIT_NAME_EMPTY })
  @MinLength(1, { message: UNIT_NAME_EMPTY })
  @MaxLength(30, { message: UNIT_NAME_TOO_LONG })
  name?: string;

  @IsOptional()
  @IsBoolean()
  archived?: boolean;
}
