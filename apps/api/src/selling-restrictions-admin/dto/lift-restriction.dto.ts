import { IsString, MaxLength, MinLength } from "class-validator";
import { Transform } from "class-transformer";

export class LiftRestrictionDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason: string;
}
